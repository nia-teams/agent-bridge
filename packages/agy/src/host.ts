import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActivityLease, IdleSleepGuard, PublicationQueue, ThreadMapStore, findExecutable, resolveThreadPrompt,
  type BridgeClient, type CardAction, type ThreadCancel, type ThreadMessage, type ToolCallResult,
} from '@nia-teams/agent-bridge-core';
import { AcpClient, AcpRpcError, isObject, type AcpMessage, type JsonObject } from './acp-client.js';
import { McpRelay } from './mcp-relay.js';

export type AgyMode = 'default' | 'accept-edits' | 'auto' | 'plan';
export type AgyBridge = Pick<BridgeClient, 'getContract' | 'credentials' | 'rpc' | 'onReady' | 'onThreadMessage' | 'onThreadCancel' | 'onCardAction' | 'verifyCardApproval'> & { isReady?: () => boolean };
export interface AgyOptions {
  configDir: string; cwd: string; agyBin?: string; model?: string; mode?: AgyMode; sandbox?: boolean; fullAuto?: boolean;
  requestTimeoutMs?: number; promptTimeoutMs?: number; approvalTimeoutMs?: number; activityRefreshMs?: number; onError?: (error: Error) => void;
}
interface Session { client: AcpClient; sid: string; revoke(): void }
interface Thread { frame: ThreadMessage; lifetime: AbortController; queued: ThreadMessage[]; session?: Session; turn?: Turn; worker?: Promise<void>; removed?: boolean }
interface Turn {
  id: string; frame: ThreadMessage; controller: AbortController; approvals: AbortController; permissions: Set<Promise<void>>;
  opening: boolean; accepting: boolean; client?: AcpClient; latest?: AbortController; prompts: Set<AbortController>;
  promptTimer?: ReturnType<typeof setTimeout>; cancelTimer?: ReturnType<typeof setTimeout>; timeout?: Error; canceledFrame?: ThreadMessage;
  complete(error?: Error): void;
}
interface Approval {
  readonly turn: Turn;
  readonly target: Readonly<Pick<ThreadMessage, 'agentThreadId' | 'groupChatId' | 'sessionId'>>;
  readonly args: JsonObject;
  settle(accepted: boolean): void;
}

const THINKING = 'Thinking in Antigravity…';
const APPROVAL_TOOL = 'agy.approval';
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const comparableCwd = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd);

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

/** Owns one ACP child generation, persistent per-chat sessions, and overlapping prompt requests. */
export class AgyHost {
  private readonly cwd: string;
  private readonly fullAuto: boolean;
  private readonly store: ThreadMapStore;
  private readonly lease: ActivityLease;
  private readonly publications: PublicationQueue;
  private readonly sleep = new IdleSleepGuard();
  private readonly relay = new McpRelay();
  private readonly threads = new Map<string, Thread>();
  private readonly sessions = new Map<string, Thread>();
  private readonly cards = new Map<string, Approval>();
  private readonly workers = new Set<Promise<void>>();
  private readonly children = new Set<AcpClient>();
  private readonly unregister: Array<() => void> = [];
  private client?: AcpClient;
  private starting?: Promise<AcpClient>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly bridge: AgyBridge, private readonly options: AgyOptions) {
    this.fullAuto = options.fullAuto ?? true;
    if (options.mode && !['default', 'accept-edits', 'auto', 'plan'].includes(options.mode)) throw new Error('Invalid ACP mode');
    for (const value of [options.requestTimeoutMs, options.promptTimeoutMs, options.approvalTimeoutMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('ACP timeouts must be positive');
    }
    this.cwd = resolve(options.cwd);
    this.store = new ThreadMapStore(options.configDir);
    this.lease = new ActivityLease(bridge, { intervalMs: options.activityRefreshMs, onError: error => this.report(error) });
    this.publications = new PublicationQueue(bridge);
  }
  private report(error: unknown): void { try { this.options.onError?.(asError(error)); } catch {} }
  async start(): Promise<void> {
    await this.store.load();
    if (this.closed) return;
    this.unregister.push(this.bridge.onThreadMessage(frame => this.message(frame)), this.bridge.onThreadCancel(frame => this.cancel(frame)), this.bridge.onCardAction(frame => this.action(frame)));
  }
  private current(thread: Thread): boolean { return !this.closed && this.threads.get(thread.frame.agentThreadId) === thread; }
  private ownsTurn(thread: Thread, turn: Turn): boolean {
    return this.current(thread) && thread.turn === turn && turn.frame.sessionId === thread.frame.sessionId;
  }
  private activity(thread: Thread, turn: Turn, state: 'executing' | 'waiting', label = THINKING): Promise<void> {
    if (!this.ownsTurn(thread, turn) || turn.controller.signal.aborted) return Promise.resolve();
    const { agentThreadId, sessionId } = turn.frame;
    return this.lease.report(agentThreadId, sessionId, state, { label, signal: turn.controller.signal });
  }
  private dropSession(thread: Thread): void {
    const session = thread.session;
    if (!session) return;
    session.revoke();
    if (this.sessions.get(session.sid) === thread) this.sessions.delete(session.sid);
    thread.session = undefined;
  }
  private ready(): Promise<AcpClient> {
    if (this.starting) return this.starting;
    if (this.client?.available) return Promise.resolve(this.client);
    const start = async () => {
      const binary = await resolveAgyBinary(this.options.agyBin);
      if (this.closed) throw new Error('Agy host is closed');
      await this.relay.start();
      if (this.closed) throw new Error('Agy host is closed');
      const args = ['acp', ...(this.fullAuto ? ['--dangerously-skip-permissions'] : []), ...(this.options.sandbox ? ['--sandbox'] : [])];
      const client = new AcpClient(binary, args, this.options.requestTimeoutMs);
      this.client = client; this.children.add(client);
      client.onMessage = message => this.receive(client, message);
      client.onExit = () => {
        if (this.client === client) this.client = undefined;
        for (const thread of this.sessions.values()) if (thread.session?.client === client) this.dropSession(thread);
        void client.close().finally(() => this.children.delete(client));
      };
      try {
        const result = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nia-agy', version: '0.3.3' } });
        if (result.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
        return client;
      } catch (error) { await client.close(); throw error; }
    };
    this.starting = start().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async open(thread: Thread, turn: Turn): Promise<Session> {
    const contract = this.bridge.getContract();
    if (!contract) throw new Error('Bridge contract is missing');
    const { agentThreadId, groupChatId, sessionId } = turn.frame;
    const saved = this.store.get(agentThreadId);
    if (saved && saved.groupChatId !== groupChatId) throw new Error('Stored session belongs to another GroupChat');
    const resume = saved?.sessionId.startsWith('v2:') && (!saved.niaSessionId || saved.niaSessionId === sessionId) &&
      (!saved.cwd || comparableCwd(saved.cwd) === comparableCwd(this.cwd)) ? saved.sessionId.slice(3) : undefined;
    const signal = turn.controller.signal;
    signal.throwIfAborted();
    const client = turn.client = await this.ready();
    const check = () => {
      signal.throwIfAborted();
      if (!this.ownsTurn(thread, turn) || thread.removed) throw new Error('ACP session is no longer assigned to this GroupChat');
      if (!client.available) throw new Error('ACP child is unavailable');
    };
    check();
    const scope = this.relay.register({ tools: contract.tools, current: () => {
      const active = thread.turn;
      if (!active?.accepting || thread.session?.revoke !== scope.revoke) return;
      return { signal: active.controller.signal, callTool: (name, args) => this.callTool(thread, active, name, args) };
    } });
    let bound = false;
    let reservedResume: string | undefined;
    try {
      const params = { cwd: this.cwd, systemPromptAppend: contract.systemPrompt, mcpServers: [{ name: 'nia-teams', command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url))], env: scope.env }] };
      let result: JsonObject | undefined;
      let sid = resume;
      if (resume) {
        if (this.sessions.has(resume)) throw new Error('ACP session is already bound to a GroupChat');
        reservedResume = resume; this.sessions.set(resume, thread);
        try { result = await client.request('session/resume', { ...params, sessionId: resume }); }
        catch (error) { if (!(error instanceof AcpRpcError)) throw error; }
        check();
        this.sessions.delete(resume); reservedResume = undefined;
      }
      if (!result) {
        result = await client.request('session/new', params);
        check();
        sid = typeof result.sessionId === 'string' ? result.sessionId : undefined;
        if (!sid?.trim()) throw new Error('ACP returned no sessionId');
      }
      check();
      if (!sid || (result.sessionId !== undefined && result.sessionId !== sid) || this.sessions.has(sid)) throw new Error('ACP session identity mismatch');
      // Reserve the returned ID before the async configuration requests.
      const session = { client, sid, revoke: scope.revoke };
      this.sessions.set(sid, thread); thread.session = session;
      const mode = this.options.mode ?? (this.fullAuto ? 'auto' : undefined);
      if (mode) { await client.request('session/set_mode', { sessionId: sid, modeId: mode }); check(); }
      if (this.options.model) { await client.request('session/set_model', { sessionId: sid, modelId: this.options.model }); check(); }
      check();
      const mapping = { sessionId: `v2:${sid}`, niaSessionId: sessionId, groupChatId, cwd: this.cwd, updatedAt: new Date().toISOString() };
      try {
        await this.store.set(agentThreadId, mapping);
        check();
      } finally {
        // A write already in progress may finish after cancel. Undo only our own
        // staged mapping; rotation/removal or another turn owns any replacement.
        if (signal.aborted && this.store.get(agentThreadId) === mapping) {
          await (saved ? this.store.set(agentThreadId, saved) : this.store.delete(agentThreadId)).catch(error => this.report(error));
        }
      }
      bound = true;
      return session;
    } finally {
      if (reservedResume && this.sessions.get(reservedResume) === thread) this.sessions.delete(reservedResume);
      if (!bound) {
        if (thread.session?.revoke === scope.revoke) this.dropSession(thread);
        else scope.revoke();
      }
    }
  }
  message(frame: ThreadMessage): void {
    if (this.closed) throw new Error('Agy host is closed');
    let thread = this.threads.get(frame.agentThreadId);
    if (thread && thread.frame.groupChatId !== frame.groupChatId) throw new Error('Thread GroupChat identity changed');
    if (thread && (thread.frame.sessionId !== frame.sessionId || thread.removed)) {
      thread.queued.length = 0;
      thread.lifetime.abort();
      this.interrupt(thread);
      this.dropSession(thread);
      if (!thread.removed) void this.store.delete(frame.agentThreadId).catch(error => this.report(error));
      thread = undefined;
    }
    if (!thread) { thread = { frame, queued: [], lifetime: new AbortController() }; this.threads.set(frame.agentThreadId, thread); }
    if (thread.turn?.accepting && thread.session?.client.available) {
      thread.frame = frame;
      this.prompt(thread, thread.turn, thread.session, [frame]);
      return;
    }
    if (thread.queued.length >= 64) throw new Error('Runtime message queue is full');
    thread.frame = frame;
    thread.queued.push(frame);
    if (!thread.worker) this.work(thread);
  }
  private work(thread: Thread): void {
    const task = this.drain(thread).catch(error => this.report(error)).finally(() => {
      this.workers.delete(task);
      if (thread.worker !== task) return;
      thread.worker = undefined;
      if (!this.current(thread)) return;
      if (thread.removed) this.threads.delete(thread.frame.agentThreadId);
      else if (thread.queued.length) this.work(thread);
    });
    thread.worker = task; this.workers.add(task);
  }
  private async drain(thread: Thread): Promise<void> {
    while (this.current(thread) && !thread.removed && thread.queued.length) {
      const first = thread.queued[0]!;
      let complete!: Turn['complete'];
      const completion = new Promise<Error | undefined>(resolve => { complete = resolve; });
      const turn: Turn = { id: randomUUID(), frame: first, controller: new AbortController(), approvals: new AbortController(), permissions: new Set(), opening: true, accepting: false, prompts: new Set(), complete };
      thread.turn = turn; this.sleep.setActive(true);
      let error: Error | undefined;
      try {
        void this.activity(thread, turn, 'executing');
        const session = thread.session?.client.available ? thread.session : await this.open(thread, turn);
        turn.opening = false;
        if (this.ownsTurn(thread, turn) && !turn.controller.signal.aborted) {
          this.prompt(thread, turn, session, thread.queued.splice(0));
          error = await completion;
        }
      } catch (cause) {
        // Failed setup consumes only the frames that were waiting for it, never a later turn.
        if (this.ownsTurn(thread, turn) && !turn.controller.signal.aborted) {
          turn.frame = thread.queued.splice(0).at(-1) ?? turn.frame;
          error = asError(cause);
        }
      }
      try {
        turn.accepting = false; turn.opening = false;
        clearTimeout(turn.promptTimer); clearTimeout(turn.cancelTimer);
        for (const request of turn.prompts) request.abort();
        turn.approvals.abort();
        if (this.ownsTurn(thread, turn)) this.lease.clear(first.agentThreadId);
        await Promise.allSettled(turn.permissions);
        await this.syncIdle(thread, turn, turn.timeout ?? error);
      } finally {
        turn.controller.abort();
        if (thread.turn === turn) thread.turn = undefined;
        this.sleep.setActive([...this.threads.values()].some(t => t.turn));
      }
    }
  }
  private prompt(thread: Thread, turn: Turn, session: Session, batch: ThreadMessage[]): void {
    turn.frame = batch.at(-1)!;
    turn.accepting = true; turn.client = session.client;
    clearTimeout(turn.promptTimer);
    const request = new AbortController();
    turn.latest = request; turn.prompts.add(request);
    if (this.options.promptTimeoutMs !== undefined) {
      turn.promptTimer = setTimeout(() => {
        turn.timeout = new Error('ACP request timeout: session/prompt');
        this.interrupt(thread);
      }, Math.min(2_147_483_647, this.options.promptTimeoutMs));
    }
    const settle = (error?: Error) => {
      turn.prompts.delete(request);
      if (turn.controller.signal.aborted ? turn.prompts.size > 0 : turn.latest !== request) return;
      turn.accepting = false;
      turn.complete(error);
    };
    void session.client.request('session/prompt', { sessionId: session.sid, prompt: [{ type: 'text', text: batch.map(resolveThreadPrompt).join('\n\n') }] }, null, request.signal).then(
      result => settle(result.stopReason === 'end_turn' ? undefined : new Error(`ACP turn did not complete: ${String(result.stopReason)}`)),
      error => settle(asError(error)),
    );
  }
  private async syncIdle(thread: Thread, turn: Turn, error?: Error): Promise<void> {
    if (!this.ownsTurn(thread, turn)) return;
    const signal = turn.controller.signal;
    const frame = turn.frame;
    const params = { state: 'idle' as const, deliveryId: frame.deliveryId, ...(error ? { errorMessage: error.message } : {}) };
    if (error && (!signal.aborted || turn.timeout)) this.report(error);
    if (!signal.aborted) {
      try {
        await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId: `turn:${turn.id}`, activityAfter: params, shouldSyncActivity: () => this.ownsTurn(thread, turn), signal });
        return;
      } catch (cause) { if (this.ownsTurn(thread, turn) && !signal.aborted) this.report(cause); }
    }
    if (this.ownsTurn(thread, turn)) {
      const idle = signal.aborted && !turn.timeout ? { state: 'idle', deliveryId: turn.canceledFrame?.deliveryId ?? frame.deliveryId } : params;
      await this.bridge.rpc('thread.activity', { sessionId: frame.sessionId, ...idle }, AbortSignal.any([thread.lifetime.signal, AbortSignal.timeout(5000)])).catch(cause => {
        if (this.ownsTurn(thread, turn)) this.report(cause);
      });
    }
  }
  private interrupt(thread: Thread): void {
    const turn = thread.turn;
    if (!turn || turn.controller.signal.aborted) return;
    turn.canceledFrame = turn.timeout ? turn.frame : thread.frame;
    turn.controller.abort(); turn.approvals.abort(); turn.accepting = false;
    clearTimeout(turn.promptTimer);
    const session = thread.session;
    if (session?.client.available && turn.prompts.size) {
      try { session.client.notify('session/cancel', { sessionId: session.sid }); } catch (error) { this.report(error); }
    }
    if (turn.opening || turn.prompts.size) {
      const client = turn.client ?? this.client;
      turn.cancelTimer = setTimeout(() => { void (client ?? turn.client ?? this.client)?.close(); }, 2000);
    }
  }
  async cancel(frame: ThreadCancel): Promise<void> {
    const thread = this.threads.get(frame.agentThreadId);
    if (!thread) {
      const saved = this.store.get(frame.agentThreadId);
      if (frame.reason === 'removed_from_group' && saved?.groupChatId === frame.groupChatId && (!saved.niaSessionId || saved.niaSessionId === frame.sessionId)) await this.store.delete(frame.agentThreadId);
      return;
    }
    if (thread.frame.sessionId !== frame.sessionId || thread.frame.groupChatId !== frame.groupChatId) return;
    thread.queued.length = 0;
    this.interrupt(thread);
    if (frame.reason === 'removed_from_group') {
      thread.removed = true; this.dropSession(thread);
      await this.store.delete(frame.agentThreadId);
      if (!thread.worker && this.current(thread)) this.threads.delete(frame.agentThreadId);
    }
  }
  private async callTool(thread: Thread, turn: Turn, name: string, args: JsonObject): Promise<ToolCallResult> {
    const signal = turn.controller.signal;
    signal.throwIfAborted();
    if (!turn.accepting || !this.ownsTurn(thread, turn)) throw new Error('No active ACP prompt');
    const frame = turn.frame;
    const toolCallId = `agy:${turn.id}:${randomUUID()}`;
    if (name === 'send_message') {
      if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('Message must be nonempty');
      const activityAfter = { state: 'executing' as const, label: THINKING };
      const revision = this.lease.record(frame.agentThreadId, frame.sessionId, activityAfter, signal);
      await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId, content: args.content, activityAfter, shouldSyncActivity: () => this.ownsTurn(thread, turn) && turn.accepting && this.lease.isCurrent(frame.agentThreadId, revision), signal });
      return { content: '消息已发布到聊天' };
    }
    const result = await this.bridge.rpc('tool.call', { sessionId: frame.sessionId, toolCallId, name, arguments: args }, signal);
    return { content: typeof result.content === 'string' ? result.content : JSON.stringify(result), ...(result.isError ? { isError: true } : {}) };
  }
  private receive(client: AcpClient, message: AcpMessage): void | Promise<void> {
    const params = message.params ?? {};
    const thread = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
    const turn = thread?.session?.client === client ? thread.turn : undefined;
    if (message.id !== undefined) {
      if (message.method !== 'session/request_permission') {
        if (client.available) client.respond(message.id, undefined, { code: -32601, message: 'Unsupported ACP client method' });
        return;
      }
      const task = this.permission(client, message.id, params, thread, turn);
      if (!turn) return task;
      turn.permissions.add(task);
      return task.finally(() => turn.permissions.delete(task));
    }
    if (message.method !== 'session/update' || !thread || !turn?.accepting || !isObject(params.update)) return;
    if ([...this.cards.values()].some(card => card.turn === turn)) return;
    const update = params.update;
    if (update.sessionUpdate === 'thought_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      return this.activity(thread, turn, 'executing');
    }
    if (['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) && update.status === 'in_progress') {
      return this.activity(thread, turn, 'executing', `Running ${String(update.title ?? update.name ?? 'tool').slice(0, 160)}…`);
    }
  }
  private async permission(client: AcpClient, id: string | number, params: JsonObject, thread?: Thread, turn?: Turn): Promise<void> {
    let allowed = false;
    if (thread && turn?.accepting && this.ownsTurn(thread, turn) && isObject(params.toolCall)) {
      const name = String(params.toolCall.name ?? '');
      const collaboration = name.startsWith('mcp__nia-teams__') || name.startsWith('nia-teams___') || params.toolCall.serverName === 'nia-teams';
      const tool = `agy:${String(params.toolCall.name ?? params.toolCall.title ?? params.toolCall.toolCallId ?? 'tool')}`;
      allowed = collaboration || this.fullAuto || await this.approve(thread, turn, tool, { sessionId: params.sessionId, toolCall: params.toolCall, options: params.options });
      allowed &&= this.ownsTurn(thread, turn) && turn.accepting && !turn.approvals.signal.aborted && thread.session?.client === client;
    }
    const optionId = permissionOption(params.options, allowed);
    if (client.available) client.respond(id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }
  private async approve(thread: Thread, turn: Turn, tool: string, input: JsonObject): Promise<boolean> {
    const cardId = `agent_bridge:${this.bridge.credentials.teamId}:approval:${randomUUID()}`;
    const { agentThreadId, groupChatId, sessionId } = turn.frame;
    const args = { agentThreadId, turnId: turn.id, tool, input };
    const signal = AbortSignal.any([turn.approvals.signal, AbortSignal.timeout(Math.min(2_147_483_647, this.options.approvalTimeoutMs ?? 300_000))]);
    let settle!: Approval['settle'];
    const decision = new Promise<boolean>(resolve => { settle = resolve; });
    const card: Approval = { turn, target: { agentThreadId, groupChatId, sessionId }, args, settle };
    this.cards.set(cardId, card);
    const deny = () => { this.cards.delete(cardId); settle(false); };
    signal.addEventListener('abort', deny, { once: true });
    void this.activity(thread, turn, 'waiting', '等待确认');
    try {
      await this.bridge.rpc('card.upsert', { sessionId, toolCallId: cardId, cardId, title: `Allow Antigravity: ${tool}?`, subtitle: tool, description: JSON.stringify(input, null, 2).slice(0, 48_000), actionLabel: '允许执行', verifyToolName: APPROVAL_TOOL, verifyArguments: args }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      return await decision && !signal.aborted;
    } catch (error) { if (!signal.aborted) this.report(error); return false; }
    finally {
      deny(); signal.removeEventListener('abort', deny);
      await this.bridge.rpc('card.cancel', { sessionId: card.target.sessionId, cardId }, AbortSignal.timeout(5000)).catch(error => this.report(error));
      if (turn.accepting && ![...this.cards.values()].some(card => card.turn === turn)) void this.activity(thread, turn, 'executing');
    }
  }
  private async action(action: CardAction): Promise<void> {
    const card = this.cards.get(action.cardId);
    if (!card || card.turn.approvals.signal.aborted) return;
    const frame = card.target;
    if (frame.sessionId !== action.sessionId || frame.agentThreadId !== action.agentThreadId || frame.groupChatId !== action.groupChatId) return;
    let allowed = false;
    if (action.decision === 'approved') {
      try { await this.bridge.verifyCardApproval(action._meta, { server: 'agent-bridge', tool: APPROVAL_TOOL, arguments: card.args, expectedCardId: action.cardId }); allowed = true; }
      catch (error) { this.report(error); }
    }
    if (this.cards.get(action.cardId) !== card) return;
    this.cards.delete(action.cardId); card.settle(allowed);
  }
  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    this.closed = true;
    for (const off of this.unregister) off();
    for (const thread of this.threads.values()) { thread.queued.length = 0; thread.lifetime.abort(); this.interrupt(thread); this.dropSession(thread); }
    this.lease.close(); this.publications.close(); this.sleep.close();
    await Promise.all([...this.children].map(client => client.close()));
    await this.starting?.catch(() => {});
    await Promise.all(this.workers);
    await this.relay.close(); this.threads.clear();
  }
}
