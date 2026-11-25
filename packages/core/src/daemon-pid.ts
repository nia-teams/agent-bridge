import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const pidFilename = 'daemon.pid';
export interface DaemonPid { pid: number; token: string; identity: string }
const exec = promisify(execFile);
const probeOptions = { timeout: 2500, windowsHide: true, maxBuffer: 8192 };
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

function checkPrivateFile(path: string, info: import('node:fs').Stats): void {
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error(`${path} must be a private regular file (chmod 600)`);
}

function privateFile(path: string) {
  try {
    const info = lstatSync(path);
    checkPrivateFile(path, info);
    return info;
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}

export function readPid(path: string): DaemonPid | undefined {
  try {
    if (!privateFile(path)) return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let record: DaemonPid | null;
    try {
      const info = fstatSync(fd);
      checkPrivateFile(path, info);
      if (info.size > 1024) throw new Error(`Invalid ${pidFilename} record`);
      record = JSON.parse(readFileSync(fd, 'utf8')) as DaemonPid | null;
    } finally { closeSync(fd); }
    if (!record || !Number.isInteger(record.pid) || record.pid < 1 || record.pid > 0x7fffffff
      || typeof record.token !== 'string' || !/^[a-f\d-]{36}$/.test(record.token)
      || typeof record.identity !== 'string' || !/^[a-f\d]{64}$/.test(record.identity)) throw new Error(`Invalid ${pidFilename} record`);
    return record;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid ${pidFilename} record`);
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

export function writePid(path: string, record: DaemonPid): void {
  privateFile(path);
  const temp = `${path}.${record.token}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function removePid(path: string, record: DaemonPid): void {
  const current = readPid(path);
  if (current?.pid !== record.pid || current.token !== record.token || current.identity !== record.identity) return;
  try { unlinkSync(path); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}

export function signalPid(pid: number, signal: 0 | 'SIGTERM'): boolean {
  try { process.kill(pid, signal); return true; }
  catch (error) { if (hasCode(error, 'ESRCH')) return false; throw error; }
}

/** Fingerprint process birth time and launch identity without persisting its command line. */
export async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    let identity: string;
    if (process.platform === 'linux') {
      const [proc, exe, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'), stat(`/proc/${pid}/exe`, { bigint: true }), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      // comm (field 2) can contain spaces or parentheses; starttime is field 22.
      const start = proc.slice(proc.lastIndexOf(')') + 2).split(' ')[19];
      if (!start || !/^\d+$/.test(start)) throw new Error();
      identity = `${boot.trim()}:${start}:${exe.dev}:${exe.ino}`;
    } else if (process.platform === 'win32') {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p -and $p.ExecutablePath -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().Ticks.ToString(); $p.ExecutablePath }`;
      const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], probeOptions);
      identity = stdout.trim();
    } else {
      const { stdout } = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { ...probeOptions, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      identity = stdout.trim();
    }
    if (identity) return createHash('sha256').update(`${pid}:${identity}`).digest('hex');
  } catch { /* Distinguish exited processes from unverifiable live processes below. */ }
  try { if (!signalPid(pid, 0)) return undefined; }
  catch (error) { if (!hasCode(error, 'EPERM')) throw error; }
  throw new Error(`Cannot verify the identity of daemon PID ${pid}; no signal was sent`);
}
