import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfigDir, executableCommand, findExecutable, ToolHttpServer, type TurnRunner } from '@nia-teams/agent-bridge-core';
import { asObject, PiExitError, PiRpcClient, PiRpcError, type RpcRecord } from './rpc-client.js';
import { LegacyTurnCompletion, promptDisposition } from './turn-completion.js';

export interface PiOptions { cwd: string; configDir?: string; model?: string; provider?: string; thinking?: string; piBin?: string }
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const extensionPath = fileURLToPath(new URL('./pi-extension.js', import.meta.url));

export function validatePiOptions(options: PiOptions): void {
  for (const [flag, value] of Object.entries({ cwd: options.cwd, model: options.model, provider: options.provider, 'pi-bin': options.piBin })) {
    if (value !== undefined && !value.trim()) throw new Error(`--${flag} must not be empty`);
  }
  if (options.thinking !== undefined && !levels.includes(options.thinking)) throw new Error(`Invalid --thinking: use ${levels.join(', ')}`);
  if (options.provider !== undefined && options.model === undefined) throw new Error('--provider requires --model');
}

export function resolvePiBinary(explicit?: string): Promise<string> {
  return findExecutable('pi', explicit ?? process.env.PI_BIN, [
    join(homedir(), '.local/bin/pi'), join(homedir(), '.bun/bin/pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi',
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm/pi')] : []),
  ]);
}

async function sessionExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sessionLoadFailure(error: unknown, path: string): boolean {
  const diagnostic = error instanceof PiExitError ? error.diagnostics : error instanceof PiRpcError ? error.message : '';
  // Only session-specific startup failures warrant retrying with a fresh file.
  return /session file is not a valid .*? session:|(?:failed|unable) to (?:load|read|open) (?:the )?session|no session found matching/i.test(diagnostic)
    || (diagnostic.includes(path) && /\b(?:ENOENT|EISDIR|EACCES|EPERM)\b/.test(diagnostic));
}

async function getState(client: PiRpcClient, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  deadline.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return asObject(await Promise.race([
      client.request('get_state'),
      new Promise<never>((_, reject) => { subscription = addAbortListener(deadline, () => reject(deadline.reason)); }),
    ]));
  } finally { subscription?.[Symbol.dispose](); }
}

export function createPiRunner(options: PiOptions): TurnRunner {
  validatePiOptions(options);
  const cwd = resolve(options.cwd);
  const sessionDir = resolve(options.configDir ?? defaultConfigDir('nia-teams-pi', 'NIA_PI_CONFIG_DIR'), 'sessions');
  return async context => {
    context.signal.throwIfAborted();
    const binary = await resolvePiBinary(options.piBin);
    const server = new ToolHttpServer(context);
    let client: PiRpcClient | undefined, promptDir: string | undefined;
    const cancellation = addAbortListener(context.signal, () => { void client?.close(true); });
    try {
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const endpoint = await server.start();
      const args = ['--mode', 'rpc', '-e', extensionPath, '--session-dir', sessionDir];
      if (context.systemPrompt) {
        promptDir = await mkdtemp(join(tmpdir(), 'nia-pi-'));
        const path = join(promptDir, 'system.md');
        await writeFile(path, context.systemPrompt, { mode: 0o600 });
        args.push('--append-system-prompt', path);
      }
      for (const key of ['provider', 'model', 'thinking'] as const) {
        const option = options[key];
        if (option !== undefined) args.push(`--${key}`, option);
      }
      const launch = async (resume?: string) => {
        context.signal.throwIfAborted();
        const command = executableCommand(binary, resume ? [...args, '--session', resume] : args);
        client = new PiRpcClient(spawn(command.file, command.args, {
          cwd, ...command.options, stdio: 'pipe', env: { ...process.env, NIA_BRIDGE_MCP_URL: endpoint.url, NIA_BRIDGE_MCP_TOKEN: endpoint.headers.Authorization.slice('Bearer '.length) },
        }));
        return getState(client, context.signal);
      };
      const resume = context.resume;
      if (resume && !isAbsolute(resume)) throw new Error('Stored Pi session path must be absolute');
      let state: Record<string, unknown> | undefined;
      if (resume && await sessionExists(resume)) {
        try { state = await launch(resume); }
        catch (error) {
          context.signal.throwIfAborted();
          if (!sessionLoadFailure(error, resume) && await sessionExists(resume)) throw error;
          await client?.close();
          state = await launch();
        }
      } else state = await launch();
      const sessionFile = state?.sessionFile;
      if (!client || typeof sessionFile !== 'string' || !isAbsolute(sessionFile)) throw new Error('Pi get_state did not return an absolute sessionFile');
      await context.session(sessionFile);
      context.signal.throwIfAborted();
      await promptTurn(client, context);
    } finally {
      try { await client?.close(context.signal.aborted); }
      finally {
        cancellation[Symbol.dispose]();
        try { await server.close(); }
        finally { if (promptDir) await rm(promptDir, { recursive: true, force: true }); }
      }
    }
  };
}

async function promptTurn(client: PiRpcClient, context: Parameters<TurnRunner>[0]): Promise<void> {
  let resolveSettled!: (event: RpcRecord) => void;
  const settled = new Promise<RpcRecord>(resolve => { resolveSettled = resolve; });
  let assistantError: string | undefined;
  const legacy = new LegacyTurnCompletion();
  const stopChecks = new AbortController();
  const unsubscribe = client.subscribe(event => {
    legacy.observe(event);
    if (event.type === 'agent_settled') resolveSettled(event);
    else if (event.type === 'tool_execution_start') {
      const tool = typeof event.toolName === 'string' ? event.toolName : 'tool';
      void context.activity('executing', `Using ${tool}…`).catch(() => {});
    } else if (event.type === 'message_end') {
      const message = asObject(event.message);
      if (message?.role === 'assistant') {
        assistantError = message.stopReason === 'error' || message.stopReason === 'aborted'
          ? typeof message.errorMessage === 'string' ? message.errorMessage : `Pi model ${message.stopReason}`
          : undefined;
      }
    }
  });
  try {
    const response = await client.whileAlive(client.request('prompt', { message: context.prompt }), context.signal);
    const disposition = promptDisposition(response);
    if (disposition === 'handled') return;
    const completion = disposition === 'legacy'
      ? Promise.race([settled, waitForLegacyIdle(client, legacy, AbortSignal.any([context.signal, stopChecks.signal]))])
      : settled;
    const event = await client.whileAlive(completion, context.signal);
    if (event?.aborted === true) throw new Error('Pi run aborted');
    if (assistantError) throw new Error(assistantError);
  } finally {
    stopChecks.abort();
    unsubscribe();
  }
}

async function waitForLegacyIdle(client: PiRpcClient, turn: LegacyTurnCompletion, signal: AbortSignal): Promise<void> {
  // Legacy acknowledgments cannot distinguish a handled prompt from a delayed
  // run. Fail explicitly rather than treating pre-run idle as a completed turn.
  const quietMs = 200;
  const startDeadline = performance.now() + 30_000;
  for (;;) {
    await delay(quietMs, undefined, { signal });
    const now = performance.now();
    if (!turn.hasRunBoundary && now >= startDeadline) {
      throw new Error('Legacy Pi RPC did not report a run; extension-handled prompts require a Pi version with prompt disposition');
    }
    if (!turn.canCheck(now, quietMs)) continue;
    const revision = turn.revision;
    const state = await getState(client, signal);
    if (turn.acceptState(state, revision)) return;
  }
}
