import { executableCommand } from '@nia-teams/agent-bridge-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type JsonObject = Record<string, unknown>;
export interface AcpMessage { jsonrpc: '2.0'; id?: string | number; method: string; params?: JsonObject }
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'AcpRpcError'; }
}
export const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
interface Pending { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** One ACP child generation; server requests and client responses use independent ID namespaces. */
export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stopped = false;
  private readonly exited: Promise<void>;
  private buffer = '';
  onMessage: (message: AcpMessage) => void | Promise<void> = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(binary: string, args: string[], private readonly requestTimeoutMs = 30_000) {
    const command = executableCommand(binary, args);
    this.child = spawn(command.file, command.args, { ...command.options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => { this.child.once('close', resolve); });
    this.child.stderr.on('data', data => process.stderr.write(data));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => {
      this.buffer += data;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) { this.fail(new Error('ACP frame exceeds 4 MiB')); return; }
        if (line.trim()) this.receive(line);
        if (this.stopped) return;
      }
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) this.fail(new Error('ACP frame exceeds 4 MiB'));
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`agy acp exited (${code ?? signal})`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  get pid(): number | undefined { return this.child.pid; }
  get available(): boolean { return !this.stopped; }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.child.kill('SIGTERM'); this.onExit(error);
  }
  private receive(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.fail(new Error('Invalid ACP JSON')); return; }
    if (!isObject(value) || value.jsonrpc !== '2.0') { this.fail(new Error('Invalid ACP envelope')); return; }
    if (typeof value.method === 'string') {
      if ((value.id !== undefined && typeof value.id !== 'number' && typeof value.id !== 'string') ||
        (value.params !== undefined && !isObject(value.params))) { this.fail(new Error('Invalid ACP request')); return; }
      const message = value as unknown as AcpMessage;
      void Promise.resolve().then(() => this.onMessage(message)).catch(() => {
        if (message.id !== undefined && this.available) this.respond(message.id, undefined, { code: -32603, message: 'ACP request failed' });
      });
      return;
    }
    if (typeof value.id !== 'number') return;
    const p = this.pending.get(value.id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(value.id);
    if (value.result === undefined && isObject(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string') {
      p.reject(new AcpRpcError(value.error.code, value.error.message));
    } else if (isObject(value.result) && value.error === undefined) p.resolve(value.result);
    else { p.reject(new Error('Invalid ACP response')); this.fail(new Error('Invalid ACP response')); }
  }
  private write(value: unknown): void {
    if (this.stopped || this.child.stdin.destroyed) throw new Error('ACP child is unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: JsonObject, timeoutMs = this.requestTimeoutMs): Promise<JsonObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`ACP request timeout: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: JsonObject): void { this.write({ jsonrpc: '2.0', method, params }); }
  respond(id: string | number, result?: JsonObject, error?: JsonObject): void {
    this.write({ jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? {} }) });
  }
  async close(): Promise<void> {
    this.fail(new Error('ACP child closed'));
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 500);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
