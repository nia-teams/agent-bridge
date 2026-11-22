import type { RpcRecord } from './rpc-client.js';

/** The Node 20 Pi release omits `data` entirely on successful prompt preflight. */
export function promptDisposition(data: unknown): 'handled' | 'started' | 'queued' | 'legacy' {
  if (data === undefined) return 'legacy';
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const { disposition } = data as Record<string, unknown>;
    if (disposition === undefined) return 'legacy';
    if (disposition === 'handled' || disposition === 'started' || disposition === 'queued') return disposition;
  }
  throw new Error('Invalid Pi RPC prompt disposition');
}

/** An idle snapshot is only useful if no lifecycle event crossed the request. */
export class LegacyTurnCompletion {
  private awaitingEnd = false;
  private sawEnd = false;
  private retrying = false;
  private compacting = false;
  private lastChange = -Infinity;
  revision = 0;

  observe(event: RpcRecord, now = performance.now()): void {
    switch (event.type) {
      case 'agent_start': this.awaitingEnd = true; break;
      case 'agent_end': this.awaitingEnd = false; this.sawEnd = true; break;
      case 'auto_retry_start': this.retrying = true; this.awaitingEnd = true; break;
      case 'auto_retry_end': this.retrying = false; break;
      case 'compaction_start': this.compacting = true; break;
      case 'compaction_end':
        this.compacting = false;
        // Pi can schedule its continuation after isCompacting becomes false.
        if (event.willRetry === true) this.awaitingEnd = true;
        break;
      case 'queue_update': break;
      default: return;
    }
    this.lastChange = now;
    this.revision++;
  }

  get hasRunBoundary(): boolean { return this.awaitingEnd || this.sawEnd; }

  private ended(): boolean { return this.sawEnd && !this.awaitingEnd && !this.retrying && !this.compacting; }

  canCheck(now: number, quietMs: number): boolean {
    return this.ended() && now - this.lastChange >= quietMs;
  }

  acceptState(state: Record<string, unknown> | undefined, revision: number): boolean {
    if (this.revision !== revision || !this.ended()) return false;
    if (typeof state?.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean' || typeof state.pendingMessageCount !== 'number') {
      throw new Error('Invalid legacy Pi RPC state for turn completion');
    }
    return !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
  }
}
