import { executableCommand, findExecutable } from '@nia-teams/agent-bridge-core';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { TurnContext, TurnResult } from '@nia-teams/agent-bridge-core';

/** Official CLI discovery prefers its OS runtime over potentially interactive npm launchers. */
export async function resolveNativeDoubaoBinary(explicit?: string, environment = { os: platform(), home: homedir(), env: process.env }, bundledDriver?: string): Promise<string> {
  const { os, home, env } = environment;
  const runtime = os === 'darwin' ? join(home, 'Library/Application Support/doubao_cli/app/current/doubao')
    : os === 'win32' ? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'doubao_cli/app/current/doubao.exe') : undefined)
    : join(env.XDG_DATA_HOME || join(home, '.local/share'), 'doubao_cli/app/current/doubao');
  const candidates = explicit ? [explicit] : [runtime, ...(env.PATH || '').split(os === 'win32' ? ';' : delimiter)
    .filter(Boolean).flatMap(dir => os === 'win32' ? [join(dir, 'doubao.exe'), join(dir, 'doubao.cmd'), join(dir, 'doubao')] : [join(dir, 'doubao')])];
  const excluded = bundledDriver ? await realpath(bundledDriver) : undefined;
  for (const path of candidates) {
    if (!path) continue;
    try {
      await access(path, os === 'win32' ? constants.F_OK : constants.X_OK);
      const canonical = await findExecutable('doubao', await realpath(resolve(path)), [], os);
      if (!(await stat(canonical)).isFile()) continue;
      // Do not confuse the unrelated bundled CDP driver with the official CLI.
      if (canonical === excluded || /[/\\]node_modules[/\\]doubao-cli[/\\]bin[/\\]doubao\.mjs$/.test(canonical)) continue;
      return canonical;
    } catch { /* Probe the next official runtime/launcher location. */ }
  }
  throw new Error(`Cannot find official @bytedance/doubao-cli${explicit ? ` at ${explicit}` : ''}. Install it or pass --doubao-bin <official-binary>; alternatively install/sign in to DoubaoWork.app or Doubao.app, or explicitly select --platform headless.`);
}
async function nativeAuthenticated(binary: string, cwd: string): Promise<boolean> {
  return new Promise((resolveStatus, reject) => {
    const command = executableCommand(binary, ['auth', 'status', '--verify']);
    execFile(command.file, command.args, { ...command.options, cwd, timeout: 30_000, maxBuffer: 64 * 1024 }, error => {
      if (!error) resolveStatus(true);
      else if (typeof error.code === 'number') resolveStatus(false);
      else reject(new Error('Unable to check Doubao CLI login; verify the official binary can run, then retry nia-doubao start.'));
    });
  });
}
export async function readyNativeDoubao(binary: string, cwd: string, interactive: boolean): Promise<void> {
  if (await nativeAuthenticated(binary, cwd)) return;
  if (!interactive) throw new Error('Doubao CLI is not signed in. Run nia-doubao start in an interactive local terminal for QR login, or run doubao login in your terminal first. Login is never performed in Nia Teams chat.');
  console.error('Doubao CLI is not signed in; launching local terminal QR login... Scan the QR code in this terminal, not in Nia Teams.');
  await new Promise<void>((resolveLogin, reject) => {
    const command = executableCommand(binary, ['login']);
    const child = spawn(command.file, command.args, { ...command.options, cwd, stdio: 'inherit' });
    child.once('error', () => reject(new Error('Unable to launch Doubao CLI login in the local terminal. Run doubao login manually.')));
    child.once('close', code => code === 0 ? resolveLogin() : reject(new Error('Doubao CLI login failed or was cancelled; run doubao login in your terminal and retry nia-doubao start.')));
  });
  if (!await nativeAuthenticated(binary, cwd)) throw new Error('Doubao CLI login exited successfully but auth status --verify still failed; complete doubao login in your terminal and retry.');
}

/** Official text CLI transport: its login, flags and session markers differ from CDP. */
export async function runNativeDoubao(binary: string, options: { cwd: string; model?: string; fullAuto?: boolean }, context: TurnContext, resume?: string): Promise<TurnResult> {
  context.signal.throwIfAborted();
  const result = await new Promise<{ text: string; sessionId?: string; code: number | null; stderr: string }>((resolveTurn, reject) => {
    const args = ['-C', options.cwd, '--permission-mode', options.fullAuto ? 'always_allow' : 'ask_always',
      ...(options.model ? ['--model', options.model] : []), ...(resume ? ['--resume', resume] : []), '-p', context.prompt];
    const command = executableCommand(binary, args);
    const child = spawn(command.file, command.args, { ...command.options, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let text = '', stderr = '', sessionId: string | undefined, overflow = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
    };
    const terminate = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 1500);
      escalation.unref();
    };
    context.signal.addEventListener('abort', terminate, { once: true });
    if (context.signal.aborted) terminate();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      text += data;
      if (Buffer.byteLength(text) > 480 * 1024) { overflow = true; terminate(); }
    });
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => {
      stderr = (stderr + line + '\n').slice(-64 * 1024);
      try {
        const event = JSON.parse(line);
        if (event.type === 'session' && typeof event.session_id === 'string' && event.session_id.trim()) sessionId = event.session_id;
      } catch { /* Native diagnostics may be plain text. */ }
    });
    const cleanup = () => { context.signal.removeEventListener('abort', terminate); if (escalation) clearTimeout(escalation); };
    child.once('error', () => { cleanup(); reject(new Error('Unable to start official Doubao CLI; check --doubao-bin and its runtime installation.')); });
    child.once('close', code => {
      if (context.signal.aborted || overflow) kill('SIGKILL');
      cleanup();
      if (context.signal.aborted) reject(context.signal.reason);
      else if (overflow) reject(new Error('Doubao output exceeds bridge frame limit'));
      else resolveTurn({ text: text.trim(), sessionId, code, stderr });
    });
  });
  context.signal.throwIfAborted();
  if (result.code !== 0) throw new Error(`Doubao CLI failed (${result.code}): ${result.stderr.trim() || 'No diagnostic output'}`);
  if (!result.sessionId) throw new Error('Doubao CLI did not emit a session marker; refusing an unresumable successful turn');
  await context.session(`cli:${result.sessionId}`);
  return { text: result.text || undefined };
}
