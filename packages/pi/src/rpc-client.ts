import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type RpcRecord = Record<string, unknown> & { type: string };
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only LF delimits Pi's records; decode incrementally across UTF-8 chunk boundaries. */
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8');
  private carry = '';
  push(chunk: Buffer, receive: (record: RpcRecord) => void): void {
    const lines = (this.carry + this.decoder.write(chunk)).split('\n');
    this.carry = lines.pop()!;
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      const record = asObject(JSON.parse(line));
      if (typeof record?.type !== 'string') throw new Error('Invalid Pi RPC record');
      receive(record as RpcRecord);
    }
  }
}

export class PiRpcError extends Error {
  constructor(readonly command: string, message: string) { super(`Pi ${command}: ${message}`); }
}
export class PiExitError extends Error {
  constructor(code: number | string | null, readonly diagnostics: string) {
    super(`Pi RPC exited (${code ?? 'unknown'})${diagnostics ? `: ${diagnostics}` : ''}`);
  }
}

const dialogs = new Set(['select', 'confirm', 'input', 'editor']);

export class PiRpcClient {
  private readonly pending = new Map<string, { command: string; resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: RpcRecord) => void>();
  private readonly decoder = new JsonlDecoder();
  private terminal?: Error;
  private stderr = '';
  private readonly closed: Promise<void>;
  private readonly exited: Promise<Error>;
  private failExit!: (error: Error) => void;
  private closing?: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise(resolve => { this.failExit = resolve; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.terminal) return;
      try { this.decoder.push(chunk, record => this.receive(record)); }
      catch (error) { this.fail(new Error('Invalid Pi RPC stdout', { cause: error })); }
    });
    // An in-flight write may see EPIPE before `close` delivers the exit diagnostic.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') this.fail(error); });
    child.stdout.on('error', error => this.fail(error));
    this.closed = new Promise(resolve => {
      child.once('close', (code, signal) => {
        this.fail(new PiExitError(code ?? signal, this.stderr.trim()));
        resolve();
      });
      child.on('error', error => {
        this.fail(error);
        // A failed spawn has no process to reap. Release its pipes even if
        // close has not arrived. An error on a live child is not an exit.
        if (child.pid === undefined) {
          this.destroyPipes();
          resolve();
        }
      });
    });
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = error;
    this.failExit(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private receive(record: RpcRecord): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : '';
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (record.command !== request.command || typeof record.success !== 'boolean') request.reject(new PiRpcError(request.command, 'invalid response'));
      else if (!record.success) request.reject(new PiRpcError(request.command, typeof record.error === 'string' ? record.error : 'request failed'));
      else request.resolve(record.data);
      return;
    }
    if (record.type === 'extension_ui_request' && typeof record.id === 'string' && typeof record.method === 'string' && dialogs.has(record.method)) {
      this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true })}\n`);
    }
    for (const listener of this.listeners) listener(record);
  }

  request(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.terminal) return Promise.reject(this.terminal);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
      // Node queues writes in order, including when the pipe applies backpressure.
      this.child.stdin.write(`${JSON.stringify({ ...args, id, type: command })}\n`);
    });
  }

  subscribe(listener: (event: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async whileAlive<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const outcome = await Promise.race([
      work.then(value => ({ value })),
      this.exited.then(error => ({ error })),
    ]);
    signal.throwIfAborted();
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  /** Send abort first; a hung Pi gets at most two seconds before termination. */
  close(abort = false): Promise<void> {
    return this.closing ??= this.shutdown(abort);
  }

  private async shutdown(abort: boolean): Promise<void> {
    const closed = this.closed.then(() => 'closed' as const);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); });
    try {
      if (abort && this.child.exitCode === null && this.child.signalCode === null) {
        const acknowledged = this.request('abort').then(() => 'ack' as const, () => 'ack' as const);
        if (await Promise.race([closed, deadline, acknowledged]) === 'closed') return;
      }
      this.child.stdin.end();
      if (await Promise.race([closed, deadline]) === 'closed') return;
    } finally { clearTimeout(timer); }

    this.child.kill('SIGTERM');
    try {
      const grace = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 500); });
      if (await Promise.race([closed, grace]) === 'closed') return;
    } finally { clearTimeout(timer); }
    this.child.kill('SIGKILL');
    // Descendants can inherit pipes and keep them open after Pi has exited.
    this.destroyPipes();
    await this.closed;
  }

  private destroyPipes(): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
