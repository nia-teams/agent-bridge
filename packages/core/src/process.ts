import { spawn, type ChildProcess } from 'node:child_process';
import { access, realpath, open, stat, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';

/** One guard per host; count active turns, not incoming messages. Best effort on macOS. */
export class IdleSleepGuard {
  private child?: ChildProcess;
  constructor(private readonly pid = process.pid) {}
  setActive(active: boolean): void {
    if (process.platform !== 'darwin') return;
    if (active && !this.child) {
      const child = spawn('caffeinate', ['-i', '-w', String(this.pid)], { stdio: 'ignore' });
      this.child = child;
      child.on('error', () => { if (this.child === child) this.child = undefined; });
      child.on('exit', () => { if (this.child === child) this.child = undefined; });
    } else if (!active) this.close();
  }
  close(): void { this.child?.kill(); this.child = undefined; }
}
/** Resolve npm/pnpm/yarn shims without invoking a shell or evaluating their contents. */
async function unwrapShim(path: string, platform: NodeJS.Platform): Promise<string> {
  const batch = /\.(?:cmd|bat)$/i.test(path);
  if (!batch && extname(path)) return path;
  const handle = await open(path, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  // Quoted paths may contain spaces; unquoted paths must stop at whitespace.
  // Keep the forms separate so a partial unquoted match cannot win inside quotes.
  const patterns = batch ? [
    /(["'])%(?:dp0%|~dp0%?)[\\/]*(?<target>[^"'%\r\n]+?\.(?:mjs|cjs|js|exe))\1/gi,
    /(?:^|\s)%(?:dp0%|~dp0%?)[\\/]*(?<target>[^\s"'%\r\n]+?\.(?:mjs|cjs|js|exe))(?=\s|$)/gi,
  ] : [
    /(["'])\$basedir[\\/](?<target>[^"'\r\n]+?\.(?:mjs|cjs|js|exe))\1/gi,
    /(?:^|\s)\$basedir[\\/](?<target>[^\s"'\r\n]+?\.(?:mjs|cjs|js|exe))(?=\s|$)/gi,
  ];
  if (batch || /^#!\s*(?:\/bin\/sh|\/usr\/bin\/env\s+sh)\b/.test(text)) {
    for (const match of patterns.flatMap(pattern => [...text.matchAll(pattern)])) {
      const target = resolve(dirname(path), match.groups!.target!.replace(/\\/g, '/'));
      // node.exe is the shim's interpreter, not its CLI entrypoint.
      if (/(?:^|[/\\])node\.exe$/i.test(target)) continue;
      try { if ((await stat(target)).isFile()) return await realpath(target); } catch { /* Try the next literal target. */ }
    }
  }
  if (!batch) {
    try { return await unwrapShim(await realpath(`${path}.cmd`), platform); } catch { /* No batch sibling. */ }
  }
  return path;
}
export async function findExecutable(name: string, explicit?: string, candidates: string[] = [], platform: NodeJS.Platform = process.platform): Promise<string> {
  const probe = (path: string) => platform === 'win32' && !extname(path) ? [`${path}.exe`, `${path}.cmd`, `${path}.bat`, path] : [path];
  const paths = explicit ? probe(explicit) : [
    ...(process.env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).flatMap(dir => probe(join(dir, name))),
    ...candidates.flatMap(probe),
  ];
  for (const path of paths) {
    try {
      const readableScript = /\.(?:[cm]?js|cmd|bat)$/i.test(path);
      await access(path, platform === 'win32' || readableScript ? constants.F_OK : constants.X_OK);
      const canonical = await realpath(resolve(path));
      if (!(await stat(canonical)).isFile()) continue;
      return await unwrapShim(canonical, platform);
    } catch { /* Probe next supported installation location. */ }
  }
  throw new Error(`Cannot find ${name}${explicit ? ` at ${explicit}` : ''}; install it or select its binary path`);
}

/** JS entrypoints always use Node, including non-executable scripts on POSIX. */
export function executableCommand(binary: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; options: { windowsHide: boolean; windowsVerbatimArguments?: boolean } } {
  const options = { windowsHide: true };
  if (/\.(?:mjs|cjs|js)$/i.test(binary)) return { file: process.execPath, args: [binary, ...args], options };
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)) {
    // cmd.exe parses a command string, not argv. Refuse shell syntax rather than
    // allowing prompts/paths to become executable commands. npm shims bypass cmd.
    const quote = (value: string) => {
      if (/["%!^&|<>\r\n\0]/u.test(value)) throw new Error('Unsafe batch argument; select the underlying .js or .exe entrypoint instead');
      return `"${value}"`;
    };
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[binary, ...args].map(quote).join(' ')}"`], options: { ...options, windowsVerbatimArguments: true } };
  }
  return { file: binary, args, options };
}

/** A short survival check, not a claim that the remote bridge is online. */
export async function maybeRespawnDaemon(args: string[], defaultLogPath: string): Promise<boolean> {
  if (!args.includes('--daemon')) return false;
  let logPath = defaultLogPath;
  const childArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--daemon') continue;
    if (args[i] === '--log-file') {
      if (!args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error('--log-file requires a path');
      logPath = args[++i]!;
    } else if (args[i]!.startsWith('--log-file=')) {
      logPath = args[i]!.slice('--log-file='.length);
      if (!logPath) throw new Error('--log-file requires a path');
    }
    else childArgs.push(args[i]!);
  }
  logPath = resolve(logPath);
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const existing = await lstat(logPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('Refusing to write daemon logs to a symlink or non-regular file');
  }
  const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  const entrypoint = process.argv[1];
  if (!entrypoint) { await log.close(); throw new Error('Cannot determine CLI entrypoint for daemon'); }
  let child: ChildProcess;
  try {
    if (!(await log.stat()).isFile()) throw new Error('Refusing to write daemon logs to a non-regular file');
    await log.chmod(0o600);
    child = spawn(process.execPath, [entrypoint, ...childArgs], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
    });
    await new Promise<void>((resolveStart, reject) => {
      const timer = setTimeout(() => { cleanup(); resolveStart(); }, 500);
      const cleanup = () => { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', exited); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number | null, signal: NodeJS.Signals | null) => fail(new Error(`Daemon exited during startup (${code ?? signal}); see ${logPath}`));
      child.once('error', fail); child.once('exit', exited);
    });
  } finally { await log.close(); }
  child.unref();
  console.log(`Started daemon (pid ${child.pid}, log: ${logPath}). Check the log and Nia Teams for readiness.`);
  return true;
}
