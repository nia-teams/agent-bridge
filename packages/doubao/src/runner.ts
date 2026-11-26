import { execFile, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopCookies } from './desktop-auth.js';
import { readyNativeDoubao, resolveNativeDoubaoBinary, runNativeDoubao } from './native.js';
import type { TurnRunner } from '@nia-teams/agent-bridge-core';

export type DoubaoPlatform = 'auto' | 'work' | 'doubao' | 'cli' | 'headless';
export type DoubaoBackend = Exclude<DoubaoPlatform, 'auto'>;
export interface DoubaoOptions {
  cwd: string; model?: string; fullAuto?: boolean; doubaoBin?: string;
  platform?: DoubaoPlatform; runtime?: 'local' | 'cloud'; restartApp?: boolean; interactive?: boolean;
  acceptanceTimeoutMs?: number; promptTimeoutMs?: number;
}
interface Result {
  conversationId?: string; runId?: string; status?: string;
  reply?: { text?: string }; available?: boolean; identityMismatch?: boolean;
  error?: string; message?: string; stopped?: boolean; loggedIn?: boolean; models?: unknown[];
}
class DriverError extends Error {
  constructor(message: string, readonly result?: Result) { super(message); }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^\d{12,24}$/.test(value);
const terminal = (status?: string) => ['completed', 'failed', 'cancelled'].includes(status ?? '');

export function resolveDoubaoPlatform(requested?: DoubaoPlatform, os = platform(), exists = existsSync, explicitBin?: string): DoubaoBackend {
  if (requested && requested !== 'auto') {
    if (requested === 'cli' || requested === 'headless') return requested;
    if (os !== 'darwin') throw new Error('Desktop Doubao requires macOS; select --platform cli or headless.');
    if (exists(`/Applications/${requested === 'work' ? 'DoubaoWork' : 'Doubao'}.app`)) return requested;
    throw new Error('Install and sign in to the selected DoubaoWork.app or Doubao.app, or select --platform cli/headless.');
  }
  if (explicitBin) return 'cli';
  if (os === 'darwin') {
    if (exists('/Applications/DoubaoWork.app')) return 'work';
    if (exists('/Applications/Doubao.app')) return 'doubao';
  }
  // Actual CLI availability is checked by resolveNativeDoubaoBinary in ready().
  return 'cli';
}
export function resolveDoubaoBinary(): string {
  return createRequire(import.meta.url).resolve('doubao-cli/bin/doubao.mjs');
}
export function resumeForBackend(resume: string | undefined, backend: DoubaoBackend): string | undefined {
  const prefix = `${backend}:`;
  return resume?.startsWith(prefix) && resume.length > prefix.length ? resume.slice(prefix.length) : undefined;
}
function command(binary: string, selected: DoubaoBackend, args: string[], cwd: string, signal?: AbortSignal, timeout = 130_000, cookie?: string): Promise<Result> {
  return new Promise((resolveResult, reject) => {
    execFile(process.execPath, [binary, '--platform', selected, '--json', ...args], {
      cwd, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1', ...(cookie ? { DOUBAO_HEADLESS_COOKIE: cookie } : {}) },
    }, (error, stdout, stderr) => {
      let result: Result | undefined;
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Result;
      } catch { /* Diagnostics, not text output, define unsuccessful commands. */ }
      if (signal?.aborted) { reject(signal.reason); return; }
      if (error) { reject(new DriverError(`Doubao ${args.slice(0, 2).join(' ')} failed: check desktop sign-in/headless credentials and runtime readiness`, result)); return; }
      if (!result) { reject(new DriverError('Doubao driver returned invalid JSON; use bundled doubao-cli@0.23.3, not @bytedance/doubao-cli.')); return; }
      resolveResult(result);
    });
  });
}

/** Startup probes are shared once per runner; turns never launch/restart/open the app. */
export function createDoubaoRunner(options: DoubaoOptions): TurnRunner & { ready(): Promise<void> } {
  const fullAuto = options.fullAuto ?? true;
  for (const value of [options.acceptanceTimeoutMs, options.promptTimeoutMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Doubao timeouts must be positive');
  let ready: Promise<void> | undefined;
  let selected: DoubaoBackend, binary: string, runtime: 'local' | 'cloud';
  const initialize = async () => {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('nia-doubao requires Node.js 22 or newer (bundled doubao-cli@0.23.3).');
    selected = resolveDoubaoPlatform(options.platform, platform(), existsSync, options.doubaoBin);
    if (selected !== 'cli' && options.doubaoBin) throw new Error('--doubao-bin selects an official native CLI; use --platform cli/auto or omit --doubao-bin for desktop/headless.');
    binary = selected === 'cli' ? await resolveNativeDoubaoBinary(options.doubaoBin, undefined, resolveDoubaoBinary()) : resolveDoubaoBinary();
    if (!(await stat(options.cwd)).isDirectory()) throw new Error('--cwd must be a directory');
    if (selected === 'cli') {
      if (options.runtime && options.runtime !== 'local') throw new Error('Native CLI mode does not accept --runtime cloud; use desktop/headless for explicit runtime selection.');
      await readyNativeDoubao(binary, options.cwd, options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
      console.error(`Doubao: official CLI ready (${binary}); permission=${fullAuto ? 'always_allow' : 'ask_always'}. Login/QR stays in the local terminal, never Nia Teams.`);
      return;
    }
    runtime = options.runtime ?? (selected === 'headless' ? 'cloud' : 'local');
    const run = (args: string[]) => command(binary, selected, args, options.cwd);
    if (selected === 'headless') {
      const status = await run(['status']);
      if (!status.loggedIn) throw new Error('Headless Doubao is not signed in. Import cookies with the bundled driver login --cookie-file <path>, or sign in to the desktop app and select --platform work/doubao. Nia Teams never starts a QR login.');
    } else {
      console.error(`Doubao: preparing ${selected === 'work' ? 'DoubaoWork.app' : 'Doubao.app'} CDP (${selected === 'work' ? 9226 : 9225}); startup may launch the app. Running apps are restarted only with --restart-app.`);
      let status: Result;
      try { status = await run(['cdp', 'status']); }
      catch (error) {
        if (!(error instanceof DriverError) || !error.result) throw error;
        status = error.result;
      }
      if (status.identityMismatch) throw new Error(status.error || 'CDP endpoint belongs to a different app; check DOUBAO_CDP_ENDPOINT.');
      if (!status.available) {
        // Upstream cdp launch can fail its obsolete model-menu probe AFTER CDP
        // opened successfully. Our objective is CDP, not DOM/model readiness.
        try { await run(['cdp', 'launch', ...(options.restartApp ? ['--yes'] : [])]); } catch { /* Recheck endpoint below. */ }
        try { status = await run(['cdp', 'status']); } catch { status = {}; }
        if (!status.available || status.identityMismatch) throw new Error('Unable to prepare Doubao CDP. Quit the app manually or pass --restart-app to authorize restart; sign in inside the selected app.');
      }
      await desktopCookies(selected);
    }
    console.error(`Doubao: ${selected} ready; runtime=${runtime}; ${runtime === 'local' ? `workspace=${options.cwd}; permission=${fullAuto ? 'FullAccess' : 'AskOnRisk'}` : 'cloud runtime (local --cwd is not a cloud workspace)'}. Doubao manages permissions without TaskBar cards.`);
  };
  const ensureReady = () => ready ??= initialize();
  const runner: TurnRunner = async context => {
    context.signal.throwIfAborted();
    await ensureReady();
    context.signal.throwIfAborted();
    const resume = resumeForBackend(context.resume, selected);
    if (selected === 'cli') return runNativeDoubao(binary, { ...options, fullAuto }, context, resume);
    if (resume && !id(resume)) throw new Error('Stored Doubao conversation ID for this backend is invalid.');
    const cookie = selected === 'work' || selected === 'doubao' ? await desktopCookies(selected, context.signal) : undefined;
    context.signal.throwIfAborted();
    let conversationId: string | undefined, runId: string | undefined, finished = false;
    let persist = Promise.resolve();
    const worker = fork(fileURLToPath(new URL('./headless-worker.js', import.meta.url)), [], {
      cwd: options.cwd, execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1', ...(cookie ? { DOUBAO_HEADLESS_COOKIE: cookie } : {}) },
    });
    let abort = () => {};
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Result>((resolveResult, reject) => {
        let receivedResult = false;
        const capture = (result?: Result) => {
          if (id(result?.conversationId) && id(result?.runId)) {
            if (conversationId && (conversationId !== result.conversationId || runId !== result.runId)) throw new Error('Doubao returned a mismatched run receipt.');
            if (resume && result.conversationId !== resume) throw new Error('Doubao returned a different conversation; refusing cross-chat publication.');
            if (!conversationId && !context.signal.aborted) {
              persist = context.session(`${selected}:${result.conversationId}`);
              void persist.catch(() => {});
            }
            const newlyAccepted = !conversationId;
            conversationId = result.conversationId; runId = result.runId;
            clearTimeout(acceptanceTimer);
            if (newlyAccepted && !context.signal.aborted && options.promptTimeoutMs !== undefined) {
              promptTimer = setTimeout(() => reject(new Error('Doubao task timed out; stopping the accepted run if known.')), Math.min(2_147_483_647, options.promptTimeoutMs));
            }
          }
        };
        abort = () => { if (conversationId && runId) reject(context.signal.reason); };
        context.signal.addEventListener('abort', abort, { once: true });
        acceptanceTimer = setTimeout(() => reject(new Error('Doubao submission acceptance timed out; no accepted run receipt received.')), Math.min(2_147_483_647, options.acceptanceTimeoutMs ?? 30_000));
        worker.on('message', (message: any) => {
          try {
            capture(message?.result);
            if (context.signal.aborted && conversationId) { reject(context.signal.reason); return; }
            if (message?.type === 'result') { receivedResult = true; resolveResult(message.result); }
            else if (message?.type === 'failed') { receivedResult = true; reject(new Error('Doubao task failed; check sign-in and local runtime/permission readiness. No automatic resend was attempted.')); }
          } catch (error) { reject(error); }
        });
        worker.once('error', () => reject(new Error('Unable to start the bundled Doubao headless task worker.')));
        worker.once('exit', () => { if (!receivedResult) reject(new Error('Doubao task worker exited before completing its run.')); });
        worker.once('disconnect', () => { /* Result IPC precedes a normal disconnect. */ });
        // The bundled driver uses Node timers internally: keep its total budget below int32 overflow.
        const timeoutSeconds = options.promptTimeoutMs !== undefined ? Math.min(2_147_000, Math.max(1, Math.ceil((options.acceptanceTimeoutMs ?? 30_000) / 1000 + options.promptTimeoutMs / 1000))) : 86_400;
        const args = ['sessions', resume ? 'send' : 'create', ...(resume ? [resume] : ['--mode', 'work']),
          '--runtime', runtime, ...(runtime === 'local' ? ['--workspace', options.cwd, '--permission', fullAuto ? 'FullAccess' : 'AskOnRisk'] : []),
          ...(options.model ? ['--model', options.model] : []), '--wait', '--timeout', String(timeoutSeconds), '--', (resume ? context.prompt : `${context.systemPrompt}\n\n${context.prompt}`)];
        worker.send({ args, fullAuto }, error => { if (error) reject(new Error('Unable to initialize Doubao task worker.')); });
      });
      await persist;
      context.signal.throwIfAborted();
      if (!conversationId || !runId) throw new Error('Doubao returned no valid conversationId/runId receipt; not retrying a possibly accepted message.');
      if (result.conversationId !== conversationId || result.runId !== runId) throw new Error('Doubao returned a mismatched run receipt.');
      finished = terminal(result.status);
      if (result.status === 'waiting_input') throw new Error('Doubao turn needs interactive input; this runtime cannot complete it through TaskBar.');
      if (result.status !== 'completed') throw new Error(`Doubao turn ${result.status ?? 'unknown'}.`);
      if (typeof result.reply?.text !== 'string' || !result.reply.text.trim()) throw new Error('Doubao completed without assistant reply.text');
      if (Buffer.byteLength(result.reply.text) > 480 * 1024) throw new Error('Doubao output exceeds bridge frame limit');
      await context.send(result.reply.text.trim());
      return;
    } finally {
      clearTimeout(acceptanceTimer); clearTimeout(promptTimer);
      context.signal.removeEventListener('abort', abort);
      // Keep the local runtime connected while the independently authenticated
      // stop command terminates this accepted run, then close its worker.
      if (conversationId && runId && (!finished || context.signal.aborted)) {
        try {
          const stopped = await command(binary, 'headless', ['sessions', 'stop', conversationId, '--run', runId, '--timeout', '15'], options.cwd, undefined, 20_000, cookie);
          if (!stopped.stopped) throw new Error();
        } catch { console.error(`Doubao: stop could not be confirmed for conversation ${conversationId}, run ${runId}; check it in Doubao.`); }
      } else if (!conversationId && context.signal.aborted) console.error('Doubao: cancellation occurred before an acceptance receipt; remote termination is unconfirmed. Do not automatically resend.');
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGTERM');
        await new Promise<void>(resolveClose => {
          const kill = setTimeout(() => { worker.kill('SIGKILL'); resolveClose(); }, 1500);
          worker.once('exit', () => { clearTimeout(kill); resolveClose(); });
        });
      }
    }
  };
  return Object.assign(runner, { ready: ensureReady });
}
