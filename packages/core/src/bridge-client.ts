import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createWorkloadOidcVerifier } from '@nia-teams/mcp-sdk/auth';
import type { ExpectedHumanActionContext, WorkloadOidcVerifier } from '@nia-teams/mcp-sdk/auth';
import { acquireLease } from './pairing.js';
import { stableExternalAgentThreadId } from './crypto.js';
import type { Credentials, ThreadMessage, CardAction, ThreadCancel, PushFrame, ReadyFrame, RpcMethod } from './types.js';

type Handler<T> = (frame: T) => void | Promise<void>;
interface PendingRpc { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
export interface BridgeClientOptions {
  clientName?: string; avatar?: string;
  heartbeatMs?: number; idleTimeoutMs?: number; reconnectBaseMs?: number; reconnectMaxMs?: number;
  rpcTimeoutMs?: number; dedupLimit?: number; onError?: (error: Error) => void;
}
export class BridgeRpcError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validPush(value: Record<string, unknown>, teamId: string): value is Record<string, unknown> & PushFrame {
  if (value.protocolVersion !== 1 || typeof value.deliveryId !== 'string' || !value.deliveryId || typeof value.sessionId !== 'string' || !/^[a-f\d]{24}$/i.test(value.sessionId)
    || typeof value.groupChatId !== 'string' || !/^[a-f\d]{24}$/i.test(value.groupChatId)
    || value.agentThreadId !== stableExternalAgentThreadId(value.groupChatId, teamId)) return false;
  switch (value.type) {
    case 'thread.message': return (value.reason === 'message' || value.reason === 'joined') && typeof value.triggerMessageId === 'string'
      && record(value.groupChat) && typeof value.groupChat.title === 'string' && typeof value.groupChat.url === 'string'
      && Array.isArray(value.groupChat.members) && value.groupChat.members.every(m => record(m) && typeof m.name === 'string' && typeof m.id === 'string')
      && (value.invokedBy === undefined || (record(value.invokedBy) && typeof value.invokedBy.userName === 'string' && (value.invokedBy.userId === undefined || typeof value.invokedBy.userId === 'string')))
      && Array.isArray(value.messages) && value.messages.every(m => record(m) && typeof m.id === 'string' && typeof m.content === 'string' && typeof m.authorName === 'string' && typeof m.createdAt === 'string'
        && ['human', 'agent', 'system'].includes(String(m.kind)) && (m.attachments === undefined || (Array.isArray(m.attachments) && m.attachments.every(a => record(a) && typeof a.name === 'string' && typeof a.url === 'string'))));
    case 'card.action': return typeof value.cardId === 'string' && value.cardId.startsWith(`agent_bridge:${teamId}:`)
      && ['approved', 'canceled'].includes(String(value.decision)) && record(value.clickedBy) && typeof value.clickedBy.userId === 'string' && typeof value.clickedBy.name === 'string'
      && (value._meta === undefined || record(value._meta));
    case 'thread.cancel': return value.reason === 'user_aborted' || value.reason === 'removed_from_group';
    default: return false;
  }
}

/** One host connection. Call start after installing push handlers; close is terminal. */
export class BridgeClient {
  private socket?: WebSocket;
  private verifier?: WorkloadOidcVerifier;
  private readonly lifetime = new AbortController();
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempt = 0;
  private ready = false;
  private lastReceived = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly delivered = new Map<string, string>();
  private readonly accepting = new Map<string, Promise<void>>();
  private readonly readyHandlers = new Set<Handler<ReadyFrame>>();
  private readonly messageHandlers = new Set<Handler<ThreadMessage>>();
  private readonly cardHandlers = new Set<Handler<CardAction>>();
  private readonly cancelHandlers = new Set<Handler<ThreadCancel>>();
  private readonly closed: Promise<Error | undefined>;
  private resolveClosed!: (error?: Error) => void;
  constructor(readonly credentials: Credentials, private readonly options: BridgeClientOptions = {}) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  /** Resolves only on terminal shutdown, never on a reconnectable disconnect. */
  whenClosed(): Promise<Error | undefined> { return this.closed; }
  onReady(handler: Handler<ReadyFrame>): () => void { this.readyHandlers.add(handler); return () => { this.readyHandlers.delete(handler); }; }
  onThreadMessage(handler: Handler<ThreadMessage>): () => void { this.messageHandlers.add(handler); return () => { this.messageHandlers.delete(handler); }; }
  onCardAction(handler: Handler<CardAction>): () => void { this.cardHandlers.add(handler); return () => { this.cardHandlers.delete(handler); }; }
  onThreadCancel(handler: Handler<ThreadCancel>): () => void { this.cancelHandlers.add(handler); return () => { this.cancelHandlers.delete(handler); }; }
  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Diagnostics must not break delivery. */ }
  }
  /** Initial failure is surfaced to the caller and also schedules a reconnect. */
  start(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Agent Bridge is closed'));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const task = this.connect();
    this.connecting = task;
    void task.then(() => { this.connecting = undefined; }, error => {
      this.connecting = undefined; this.report(error); this.scheduleReconnect();
    });
    return task;
  }
  private scheduleReconnect(): void {
    if (this.lifetime.signal.aborted || this.reconnectTimer) return;
    const maximum = this.options.reconnectMaxMs ?? 30_000;
    const base = Math.min(maximum, (this.options.reconnectBaseMs ?? 1000) * 2 ** Math.min(this.attempt++, 12));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.start().catch(() => {}); }, base * (0.75 + Math.random() * 0.5));
  }
  private async connect(): Promise<void> {
    const lease = await acquireLease(this.credentials, this.lifetime.signal, this.options);
    this.lifetime.signal.throwIfAborted();
    const socket = new WebSocket(lease.gatewayUrl, { maxPayload: 512 * 1024, handshakeTimeout: 15_000, followRedirects: false });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let established = false;
      const timer = setTimeout(() => { reject(new Error('Agent Bridge ready timeout')); socket.terminate(); }, 15_000);
      const stop = (): void => { socket.terminate(); };
      this.lifetime.signal.addEventListener('abort', stop, { once: true });
      socket.on('open', () => {
        try { this.send({ type: 'hello', protocolVersion: 1, teamId: this.credentials.teamId, lease: lease.lease, hostLabel: this.credentials.hostLabel }); }
        catch (error) { reject(error); socket.terminate(); }
      });
      socket.on('message', (data, binary) => {
        if (binary) { socket.close(4400, 'binary frames unsupported'); return; }
        let value: unknown;
        try { value = JSON.parse(data.toString()); } catch { socket.close(4400, 'invalid JSON'); return; }
        if (!record(value) || value.protocolVersion !== 1) { socket.close(4400, 'invalid frame'); return; }
        this.lastReceived = Date.now();
        if (!established) {
          const frame = value as unknown as ReadyFrame;
          if (frame.type !== 'ready' || frame.agent?.teamId !== this.credentials.teamId || frame.issuer !== this.credentials.issuer || typeof frame.connectionGeneration !== 'string') {
            socket.close(4401, 'invalid ready'); return;
          }
          this.verifier = createWorkloadOidcVerifier({ issuer: frame.issuer, jwksUrl: new URL('/oauth2/jwks', this.credentials.serverUrl).href });
          established = true; this.ready = true; this.attempt = 0; clearTimeout(timer);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastReceived > (this.options.idleTimeoutMs ?? 60_000)) { socket.terminate(); return; }
            try { this.send({ type: 'heartbeat', protocolVersion: 1, at: Date.now() }); }
            catch (error) { this.report(error); socket.terminate(); }
          }, this.options.heartbeatMs ?? 20_000);
          resolve();
          for (const handler of this.readyHandlers) void Promise.resolve().then(() => handler(frame)).catch(error => this.report(error));
          return;
        }
        void this.receive(value, socket).catch(error => this.report(error));
      });
      socket.on('error', error => { this.report(error); if (!established) reject(error); socket.terminate(); });
      socket.on('close', (code, reason) => {
        clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', stop);
        if (this.socket === socket) {
          this.ready = false; this.verifier = undefined; this.socket = undefined;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = undefined;
          for (const pending of this.pending.values()) pending.reject(new Error('Agent Bridge disconnected'));
          this.pending.clear();
          // A superseded host must not compete with its replacement indefinitely.
          if (code === 4409) this.close(new BridgeRpcError('host_superseded', `Agent Bridge host superseded (4409${reason.length ? ': ' + reason.toString() : ''}); another host replaced this daemon`, false));
          else {
            if (established && !this.lifetime.signal.aborted) this.report(new Error(`Agent Bridge disconnected (${code}); reconnecting`));
            this.scheduleReconnect();
          }
        }
        if (!established) reject(new Error(`Agent Bridge disconnected before ready (${code})`));
      });
    });
  }
  private send(frame: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Agent Bridge is not connected');
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > 512 * 1024) throw new BridgeRpcError('invalid_request', 'Agent Bridge frame exceeds 512 KB', false);
    this.socket.send(text);
  }
  private async receive(value: Record<string, unknown>, socket: WebSocket): Promise<void> {
    if (value.type === 'heartbeat') return;
    if (value.type === 'rpc.response') {
      if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') { socket.close(4400, 'invalid RPC response'); return; }
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      this.pending.delete(value.requestId);
      if (value.ok) pending.resolve(record(value.result) ? value.result : {});
      else {
        const error = record(value.error) ? value.error : {};
        pending.reject(new BridgeRpcError(String(error.code ?? 'RPC_ERROR'), String(error.message ?? 'Agent Bridge RPC failed'), error.retryable === true));
      }
      return;
    }
    if (!validPush(value, this.credentials.teamId)) { socket.close(4400, 'invalid push'); return; }
    const frame = value;
    const key = `${frame.sessionId}:${frame.deliveryId}`;
    if (!this.delivered.has(key)) {
      let task = this.accepting.get(key);
      if (!task) {
        task = (async () => {
          const handlers = frame.type === 'thread.message' ? this.messageHandlers : frame.type === 'card.action' ? this.cardHandlers : this.cancelHandlers;
          if (handlers.size === 0) throw new Error(`No handler for ${frame.type}; delivery not acknowledged`);
          for (const handler of handlers) await (handler as Handler<PushFrame>)(frame);
          this.delivered.set(key, frame.sessionId);
          while (this.delivered.size > (this.options.dedupLimit ?? 2000)) this.delivered.delete(this.delivered.keys().next().value!);
        })();
        this.accepting.set(key, task);
        void task.finally(() => { this.accepting.delete(key); }).catch(() => {});
      }
      await task;
    }
    // Reply only to the delivering socket. Reconnect replay gets its own ack.
    if (this.socket === socket && this.ready) this.send({ type: 'ack', protocolVersion: 1, sessionId: frame.sessionId, deliveryId: frame.deliveryId });
  }
  private waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timer); off();
        signal?.removeEventListener('abort', aborted);
        this.lifetime.signal.removeEventListener('abort', closed);
        if (error !== undefined) reject(error); else resolve();
      };
      const off = this.onReady(() => finish());
      const aborted = (): void => finish(new Error('Agent Bridge RPC aborted', { cause: signal?.reason }));
      const closed = (): void => finish(this.lifetime.signal.reason);
      const timer = setTimeout(() => finish(new Error('Agent Bridge ready timeout')), this.options.rpcTimeoutMs ?? 30_000);
      signal?.addEventListener('abort', aborted, { once: true });
      this.lifetime.signal.addEventListener('abort', closed, { once: true });
    });
  }
  async rpc(method: RpcMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    // Wait for the handshake when reconnecting. Never replay an RPC already sent:
    // only the publication owner can safely retry with its idempotency key.
    await this.waitUntilReady(signal);
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: Record<string, unknown>): void => {
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); this.pending.delete(requestId);
        if (error) reject(error); else resolve(result ?? {});
      };
      const aborted = (): void => finish(new Error('Agent Bridge RPC aborted', { cause: signal?.reason }));
      const timer = setTimeout(() => finish(new Error('Agent Bridge RPC timeout')), this.options.rpcTimeoutMs ?? 30_000);
      this.pending.set(requestId, { resolve: result => finish(undefined, result), reject: error => finish(error) });
      signal?.addEventListener('abort', aborted, { once: true });
      try { this.send({ type: 'rpc.request', protocolVersion: 1, requestId, method, params }); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  verifyCardApproval(meta: Record<string, unknown> | undefined, expected: ExpectedHumanActionContext) {
    if (!this.verifier) return Promise.reject(new Error('Agent Bridge OIDC verifier is not ready'));
    return this.verifier.verifyHumanActionContext(meta, expected);
  }
  close(error?: Error): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(error ?? new Error('Agent Bridge closed'));
    this.resolveClosed(error); this.ready = false; this.verifier = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) pending.reject(new Error('Agent Bridge closed'));
    this.pending.clear(); this.readyHandlers.clear(); this.socket?.terminate();
  }
}
