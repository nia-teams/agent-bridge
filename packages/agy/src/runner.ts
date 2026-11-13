import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable, GROUP_CHAT_INSTRUCTIONS, type TurnContext, type TurnRunner } from '@nia-teams/agent-bridge-core';
import { AcpClient, AcpRpcError, isObject, type AcpMessage, type JsonObject } from './acp-client.js';
import { McpRelay } from './mcp-relay.js';

export type AgyMode = 'default' | 'accept-edits' | 'auto' | 'plan';
export interface AgyOptions {
  cwd: string; agyBin?: string; model?: string; mode?: AgyMode; sandbox?: boolean; fullAuto?: boolean;
  requestTimeoutMs?: number; promptTimeoutMs?: number;
}
interface Active { client: AcpClient; context: TurnContext; text: string; prompting: boolean }
export async function resolveAgyBinary(explicit?: string): Promise<string> {
  return findExecutable('agy', explicit ?? process.env.AGY_BIN, [join(homedir(), '.local/bin/agy'), join(homedir(), '.antigravity/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']);
}
export function permissionOption(options: unknown, allowed: boolean): string | undefined {
  if (!Array.isArray(options)) return;
  const kind = allowed ? 'allow_once' : 'reject_once', fallback = allowed ? 'allow' : 'deny';
  const option = options.find(o => isObject(o) && typeof o.optionId === 'string' && o.kind === kind) ??
    options.find(o => isObject(o) && o.optionId === fallback && o.kind === undefined);
  return isObject(option) && typeof option.optionId === 'string' ? option.optionId : undefined;
}

/** One shared ACP process; SessionHost supplies private per-chat persistence and serial turn queues. */
export class AgyRunner {
  private client?: AcpClient;
  private starting?: Promise<AcpClient>;
  private readonly children = new Set<AcpClient>();
  private readonly relay = new McpRelay();
  private readonly active = new Map<string, Active>();
  private closed = false;
  readonly run: TurnRunner = context => this.turn(context);
  constructor(private readonly options: AgyOptions) {
    if (options.mode && !['default', 'accept-edits', 'auto', 'plan'].includes(options.mode)) throw new Error('Invalid ACP mode');
    for (const value of [options.requestTimeoutMs, options.promptTimeoutMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('ACP timeouts must be positive');
  }
  private async ready(signal: AbortSignal): Promise<AcpClient> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Agy runner is closed');
    if (this.starting) return this.starting;
    if (this.client?.available) return this.client;
    const start = async () => {
      const binary = await resolveAgyBinary(this.options.agyBin);
      signal.throwIfAborted();
      if (this.closed) throw new Error('Agy runner is closed');
      await this.relay.start();
      signal.throwIfAborted();
      if (this.closed) throw new Error('Agy runner is closed');
      const args = ['acp', ...(this.options.fullAuto ? ['--dangerously-skip-permissions'] : []), ...(this.options.sandbox ? ['--sandbox'] : [])];
      const client = new AcpClient(binary, args, this.options.requestTimeoutMs); this.client = client; this.children.add(client);
      client.onMessage = message => this.message(client, message);
      client.onExit = () => {
        if (this.client === client) this.client = undefined;
        void client.close().finally(() => this.children.delete(client));
      };
      try {
        const result = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nia-agy', version: '0.1.0' } });
        if (result.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
        return client;
      } catch (error) { await client.close(); throw error; }
    };
    this.starting = start();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  private async turn(context: TurnContext): Promise<{ text?: string }> {
    context.signal.throwIfAborted();
    let client: AcpClient | undefined, sid: string | undefined;
    let revoke: (() => void) | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      const owned = client ?? this.client;
      if (sid && owned?.available) { try { owned.notify('session/cancel', { sessionId: sid }); } catch {} }
      cancelTimer = setTimeout(() => { void (owned ?? client ?? this.client)?.close(); }, 2000);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      client = await this.ready(context.signal); context.signal.throwIfAborted();
      const scope = this.relay.register(context); revoke = scope.revoke;
      const mcpServers = [{ name: 'nia-teams', command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url))], env: scope.env }];
      let result: JsonObject | undefined;
      if (context.resume) {
        if (this.active.has(context.resume)) throw new Error('ACP session already has an active turn');
        try { result = await client.request('session/resume', { sessionId: context.resume, cwd: this.options.cwd, mcpServers }); }
        catch (error) { if (!(error instanceof AcpRpcError)) throw error; }
        context.signal.throwIfAborted();
        if (result) sid = context.resume;
      }
      if (!result) {
        result = await client.request('session/new', { cwd: this.options.cwd, mcpServers, systemPromptAppend: GROUP_CHAT_INSTRUCTIONS });
        if (typeof result.sessionId !== 'string' || !result.sessionId.trim()) throw new Error('ACP returned no sessionId');
        sid = result.sessionId;
      }
      context.signal.throwIfAborted();
      if (!sid || (typeof result.sessionId === 'string' && result.sessionId !== sid) || this.active.has(sid)) throw new Error('ACP session identity mismatch');
      await context.session(sid);
      const active: Active = { client, context, text: '', prompting: false }; this.active.set(sid, active);
      const mode = this.options.mode ?? (this.options.fullAuto ? 'auto' : undefined);
      if (mode) await client.request('session/set_mode', { sessionId: sid, modeId: mode });
      if (this.options.model) await client.request('session/set_model', { sessionId: sid, modelId: this.options.model });
      context.signal.throwIfAborted();
      active.prompting = true;
      const completion = await client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: context.prompt }] }, this.options.promptTimeoutMs ?? 600_000);
      context.signal.throwIfAborted();
      if (completion.stopReason !== 'end_turn') throw new Error(`ACP turn did not complete: ${String(completion.stopReason)}`);
      return { text: active.text || undefined };
    } finally {
      context.signal.removeEventListener('abort', abort);
      if (cancelTimer) clearTimeout(cancelTimer);
      revoke?.();
      if (sid && this.active.get(sid)?.context === context) this.active.delete(sid);
    }
  }
  private message(client: AcpClient, message: AcpMessage): void | Promise<void> {
    const params = message.params ?? {};
    const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
    const active = this.active.get(sid);
    if (message.method === 'session/request_permission' && message.id !== undefined) return this.permission(client, message.id, params, active);
    if (message.id !== undefined) { client.respond(message.id, undefined, { code: -32601, message: 'Unsupported ACP client method' }); return; }
    if (message.method !== 'session/update' || !active || active.client !== client || !active.prompting || active.context.signal.aborted || !isObject(params.update)) return;
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && isObject(update.content) && update.content.type === 'text') {
      if (typeof update.content.text !== 'string') { void client.close(); return; }
      active.text += update.content.text;
      if (Buffer.byteLength(active.text) > 480 * 1024) { void client.close(); return; }
    } else if (update.sessionUpdate === 'thought_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      void active.context.activity('executing', 'Thinking in Antigravity…').catch(() => {});
    } else if (['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) && update.status === 'in_progress') {
      void active.context.activity('executing', `Running ${String(update.title ?? update.name ?? 'tool').slice(0, 160)}…`).catch(() => {});
    }
  }
  private async permission(client: AcpClient, id: string | number, params: JsonObject, active?: Active): Promise<void> {
    let allowed = false;
    if (active?.client === client && active.prompting && !active.context.signal.aborted && isObject(params.toolCall)) {
      try {
        // Prefix ACP names so a runtime tool cannot impersonate SessionHost's human-question path.
        const tool = `agy:${String(params.toolCall.name ?? params.toolCall.title ?? params.toolCall.toolCallId ?? 'tool')}`;
        const result = await active.context.permission(tool, { sessionId: params.sessionId, toolCall: params.toolCall, options: params.options });
        allowed = result.behavior === 'allow' && !active.context.signal.aborted && this.active.get(String(params.sessionId)) === active;
      } catch { allowed = false; }
    }
    const optionId = permissionOption(params.options, allowed);
    if (client.available) client.respond(id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.children].map(client => client.close()));
    if (this.starting) await this.starting.catch(() => {});
    await this.relay.close(); this.active.clear();
  }
}
export function createAgyRunner(options: AgyOptions): TurnRunner & { close(): Promise<void> } {
  const runner = new AgyRunner(options);
  return Object.assign(runner.run, { close: () => runner.close() });
}
