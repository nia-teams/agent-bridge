import { BridgeRpcError } from './bridge-client.js';
import type { RpcMethod } from './types.js';

interface PublicationBridge {
  onReady(handler: () => void): () => void;
  rpc(method: RpcMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export interface Publication {
  niaSessionId: string;
  toolCallId: string;
  content?: string;
  activityAfter: { state: 'idle' | 'waiting' | 'executing'; label?: string; errorMessage?: string };
  shouldSyncActivity: () => boolean;
  signal?: AbortSignal;
}
interface PendingPublication extends Publication {
  bytes: number;
  published: boolean;
  controller: AbortController;
  completion: Promise<void>;
  finish(error?: unknown): void;
}
export interface PublicationQueueOptions { maxItems?: number; maxBytes?: number; retryMs?: number }

/** Process-local, FIFO, idempotent publication retries. Never evicts an accepted publication. */
export class PublicationQueue {
  private readonly pendingPublications = new Map<string, PendingPublication>();
  private bytes = 0;
  private closed = false;
  private flushing?: Promise<void>;
  private flushRequested = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly unregisterReady: () => void;
  constructor(private readonly bridge: PublicationBridge, private readonly options: PublicationQueueOptions = {}) {
    this.unregisterReady = bridge.onReady(() => { this.flushRequested = true; void this.flush(); });
  }
  /** Admission errors are synchronous; accepted entries survive transient failures until completion or cancellation. */
  enqueue(publication: Publication): Promise<void> {
    if (this.closed) throw new Error('Publication queue is closed');
    publication.signal?.throwIfAborted();
    // Session identity is part of the key because Nia sessions can rotate independently of the host thread.
    const key = JSON.stringify([publication.niaSessionId, publication.toolCallId]);
    const previous = this.pendingPublications.get(key);
    if (previous) {
      if (previous.content !== publication.content) throw new Error('Publication idempotency key reused with different content');
      return previous.completion;
    }
    const params = { sessionId: publication.niaSessionId, toolCallId: publication.toolCallId, content: publication.content };
    const messageBytes = Buffer.byteLength(JSON.stringify(params));
    const activityBytes = Buffer.byteLength(JSON.stringify({ sessionId: publication.niaSessionId, ...publication.activityAfter }));
    const bytes = messageBytes + activityBytes;
    // Include the RPC envelope and UUID overhead in the protocol frame bound.
    if (Math.max(messageBytes, activityBytes) + 256 > 512 * 1024) throw new BridgeRpcError('invalid_request', 'Publication exceeds the Agent Bridge frame limit', false);
    if (this.pendingPublications.size >= (this.options.maxItems ?? 256) || this.bytes + bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) {
      throw new Error('Publication queue is full; no accepted publications were discarded');
    }
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Detached final publications are still observed by their owner, but cancellation may happen before it attaches.
    void completion.catch(() => {});
    const controller = new AbortController();
    const abort = (): void => entry.finish(publication.signal?.reason ?? new Error('Publication aborted'));
    const entry: PendingPublication = { ...publication, bytes, published: !publication.content, controller, completion,
      finish: error => {
        if (this.pendingPublications.get(key) !== entry) return;
        this.pendingPublications.delete(key); this.bytes -= bytes;
        publication.signal?.removeEventListener('abort', abort);
        controller.abort();
        if (error === undefined) resolve(); else reject(error);
      },
    };
    this.pendingPublications.set(key, entry); this.bytes += bytes;
    publication.signal?.addEventListener('abort', abort, { once: true });
    this.flushRequested = true;
    void this.flush();
    return completion;
  }
  /** One worker serializes initial sends, retries and ready notifications, preserving FIFO order. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    const task = this.drain();
    this.flushing = task;
    void task.finally(() => {
      this.flushing = undefined;
      // A ready notification can race a rejected in-flight RPC. Do not lose that wakeup.
      if (this.flushRequested && this.pendingPublications.size && !this.closed) void this.flush();
    });
    return task;
  }
  private async drain(): Promise<void> {
    while (!this.closed && this.pendingPublications.size) {
      this.flushRequested = false;
      const entry = this.pendingPublications.values().next().value!;
      try {
        if (!entry.published) {
          await this.bridge.rpc('group_chat.send_message', { sessionId: entry.niaSessionId, toolCallId: entry.toolCallId, content: entry.content }, entry.controller.signal);
          entry.published = true;
        }
        if (!entry.controller.signal.aborted && entry.shouldSyncActivity()) {
          await this.bridge.rpc('thread.activity', { sessionId: entry.niaSessionId, ...entry.activityAfter }, entry.controller.signal);
        }
        entry.finish();
      } catch (error) {
        if (entry.controller.signal.aborted) continue;
        if (error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === false) {
          entry.finish(error); continue;
        }
        if (this.flushRequested) continue;
        // Also retry RPC timeouts / retryable server failures when the socket never closes.
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush(); }, this.options.retryMs ?? 2000);
        return;
      }
    }
    this.flushRequested = false;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.unregisterReady();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const entry of this.pendingPublications.values()) entry.finish(new Error('Publication queue is closed'));
  }
}
