import type { BridgeClient } from './bridge-client.js';

export interface ActivityLeaseOptions { intervalMs?: number; rpcTimeoutMs?: number; onError?: (error: Error) => void }
export interface ActiveActivity { state: 'executing' | 'waiting'; label?: string }
interface Entry { sessionId: string; value: ActiveActivity; revision: number; controller: AbortController; detach(): void; pending?: Promise<void> }

/** Process-local live activity projection. Idle publication remains owned by the caller. */
export class ActivityLease {
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly off: () => void;
  private closed = false;
  constructor(private readonly bridge: Pick<BridgeClient, 'rpc' | 'onReady'>, private readonly options: ActivityLeaseOptions = {}) {
    this.off = bridge.onReady(() => { for (const [key, entry] of this.entries) void this.send(key, entry); });
  }
  record(key: string, sessionId: string, value: ActiveActivity, signal?: AbortSignal): number | undefined {
    this.clear(key);
    if (this.closed || signal?.aborted) return;
    const abort = () => this.clear(key);
    const entry: Entry = { sessionId, value: { ...value }, revision: ++this.revision, controller: new AbortController(), detach: () => signal?.removeEventListener('abort', abort) };
    this.entries.set(key, entry);
    signal?.addEventListener('abort', abort, { once: true });
    this.timer ??= setInterval(() => { for (const [id, current] of this.entries) void this.send(id, current); }, this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
    return entry.revision;
  }
  isCurrent(key: string, revision: number | undefined): boolean {
    return revision !== undefined && this.entries.get(key)?.revision === revision;
  }
  async report(key: string, sessionId: string, state: ActiveActivity['state'], opts: { label?: string; signal?: AbortSignal } = {}): Promise<void> {
    this.record(key, sessionId, { state, ...(opts.label ? { label: opts.label } : {}) }, opts.signal);
    const entry = this.entries.get(key);
    if (entry) await this.send(key, entry);
  }
  private send(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key)?.revision !== entry.revision || entry.controller.signal.aborted) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(this.options.rpcTimeoutMs ?? 5000)]);
    entry.pending = (async () => {
      try { await this.bridge.rpc('thread.activity', { sessionId: entry.sessionId, ...entry.value }, signal); }
      catch (error) {
        if (!entry.controller.signal.aborted) { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch {} }
      }
    })().finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
  clear(key: string): void {
    const entry = this.entries.get(key);
    this.entries.delete(key); ++this.revision;
    entry?.detach(); entry?.controller.abort();
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.off();
    for (const key of this.entries.keys()) this.clear(key);
  }
}
