import { executableCommand, findExecutable } from '@nia-teams/agent-bridge-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type JsonObject = Record<string, any>;
export interface ServerMessage { id?: string | number; method: string; params?: JsonObject }
/** JSONL JSON-RPC transport. Server requests never block receipt of client responses. */
export class AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onMessage: (message: ServerMessage) => Promise<void> | void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(private readonly binary = process.env.CODEX_BIN || 'codex', private readonly timeoutMs = 30_000) {}
  get pid(): number | undefined { return this.child?.pid; }
  async start(): Promise<void> {
    if (this.child) throw new Error('Codex app-server already started');
    const isPath = /[/\\]/.test(this.binary);
    // Preserve spawn's ENOENT error contract for unavailable explicit binaries.
    const binary = await findExecutable(isPath ? 'codex' : this.binary, isPath ? this.binary : undefined).catch(() => this.binary);
    const command = executableCommand(binary, ['app-server']);
    const child = spawn(command.file, command.args, { ...command.options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // Codex diagnostics are not part of the JSONL stream.
    child.stderr.on('data', data => process.stderr.write(data));
    const fail = (error: Error) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.onExit(error);
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Codex app-server exited (${code ?? signal})`)));
    child.stdin.on('error', fail);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.method) {
          void Promise.resolve(this.onMessage(value)).catch(error => {
            if (value.id !== undefined) this.respond(value.id, undefined, { code: -32603, message: String(error) });
            else this.onExit(error instanceof Error ? error : new Error(String(error)));
          });
        } else {
          const p = this.pending.get(value.id);
          if (!p) return;
          clearTimeout(p.timer); this.pending.delete(value.id);
          if (value.error) p.reject(new Error(value.error.message || JSON.stringify(value.error)));
          else p.resolve(value.result ?? {});
        }
      } catch (error) { fail(new Error('Invalid Codex JSONL', { cause: error })); child.kill(); }
    });
    await this.request('initialize', { clientInfo: { name: 'nia-teams-codex-bridge', title: 'Nia Teams Codex Bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
  }
  private write(value: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex app-server is unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timeout: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: JsonObject): void { this.write({ jsonrpc: '2.0', method, params }); }
  respond(id: string | number, result?: JsonObject, error?: JsonObject): void {
    this.write({ jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? {} }) });
  }
  close(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex app-server closed')); }
    this.pending.clear(); this.child?.kill();
  }
}
