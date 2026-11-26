import { ActivityLease } from './activity.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RuntimeMissingResultError } from './sdk-turn.js';
import type { BridgeClient } from './bridge-client.js';
import type { CardAction, ThreadMessage, ThreadCancel, ActivityState, BridgeToolDefinition } from './types.js';
import { PublicationQueue } from './publications.js';
import { ThreadMapStore } from './state.js';
import { IdleSleepGuard } from './process.js';
import { resolveThreadPrompt } from './format.js';
export type SessionBridge = Pick<BridgeClient, 'getContract' | 'credentials' | 'rpc' | 'onReady' | 'onThreadMessage' | 'onThreadCancel' | 'onCardAction' | 'verifyCardApproval'> & { isReady?: () => boolean };
export interface PermissionDecision { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }
export interface ToolCallResult { content: string; isError?: boolean }
export interface TurnContext {
  callTool(name: string, args: Record<string, unknown>, toolCallId?: string): Promise<ToolCallResult>;
  systemPrompt: string; tools: BridgeToolDefinition[]; deliveryId: string;
  prompt: string; resume?: string; signal: AbortSignal; turnId: string;
  session(id: string): Promise<void>;
  activity(state: ActivityState, label?: string): Promise<void>;
  send(content: string, toolCallId?: string): Promise<void>;
  history(limit?: number, offset?: number): Promise<ToolCallResult>;
  permission(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<PermissionDecision>;
}
export type TurnResult = void;
export type TurnRunner = (context: TurnContext) => Promise<TurnResult>;
export interface SessionHostOptions { clientName?: string; avatar?: string; configDir: string; cwd?: string; runtime: string; approvalTool: string; fullAuto?: boolean; approvalTimeoutMs?: number; activityRefreshMs?: number; onError?: (error: Error) => void; maxQueuedMessages?: number }
interface Active { finishing?: boolean; controller: AbortController; id: string }
interface Thread { frame: ThreadMessage; active?: Active; queue: ThreadMessage[]; worker?: Promise<void>; question?: { userId?: string; questions: Array<{ question: string }>; resolve(input: Record<string, unknown>): void } }
interface PendingCard { thread: Thread; active: Active; args: Record<string, unknown>; resolve(value: boolean): void }

function comparableCwd(cwd: string): string {
  const absolute = resolve(cwd);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Shared turn lifecycle for runtimes whose query API runs one turn to completion. */
export class SessionHost {
  private readonly lease: ActivityLease;
  private readonly store: ThreadMapStore;
  private readonly cwd?: string;
  private readonly publications: PublicationQueue;
  private readonly threads = new Map<string, Thread>();
  private readonly cards = new Map<string, PendingCard>();
  private readonly sleep = new IdleSleepGuard();
  private readonly unregister: Array<() => void> = [];
  private closed = false;
  constructor(private readonly bridge: SessionBridge, private readonly runner: TurnRunner, private readonly options: SessionHostOptions) {
    this.lease = new ActivityLease(bridge, { intervalMs: options.activityRefreshMs, onError: error => this.report(error) });
    this.cwd = options.cwd ? resolve(options.cwd) : undefined;
    this.store = new ThreadMapStore(options.configDir); this.publications = new PublicationQueue(bridge);
  }
  private report(error: unknown): void { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch {} }
  async start(): Promise<void> {
    await this.store.load();
    this.unregister.push(this.bridge.onThreadMessage(frame => this.message(frame)), this.bridge.onThreadCancel(frame => this.cancel(frame)), this.bridge.onCardAction(frame => this.action(frame)));
  }
  private guard(): void { this.sleep.setActive([...this.threads.values()].some(t => t.active)); }
  private async activity(thread: Thread, frame: ThreadMessage, active: Active, state: ActivityState, label?: string, errorMessage?: string): Promise<void> {
    if (thread.active !== active || frame.sessionId !== thread.frame.sessionId) return;
    if (state !== 'idle' && (active.finishing || active.controller.signal.aborted)) return;
    if (state !== 'idle') return this.lease.report(frame.agentThreadId, frame.sessionId, state, { label, signal: active.controller.signal });
    this.lease.clear(frame.agentThreadId);
    // Progress is best-effort telemetry, not a prerequisite for SDK execution.
    // Final publication/idle ordering remains owned by PublicationQueue.
    await this.bridge.rpc('thread.activity', { sessionId: frame.sessionId, state, ...(state === 'idle' ? { deliveryId: frame.deliveryId } : {}), ...(label ? { label } : {}), ...(errorMessage ? { errorMessage } : {}) }, AbortSignal.timeout(5000)).catch(error => this.report(error));
  }
  message(frame: ThreadMessage): void {
    if (this.closed) throw new Error('Session host is closed');
    let thread = this.threads.get(frame.agentThreadId);
    if (!thread) { thread = { frame, queue: [] }; this.threads.set(frame.agentThreadId, thread); }
    if (thread.frame.groupChatId !== frame.groupChatId) throw new Error('Thread GroupChat identity changed');
    if (thread.frame.sessionId !== frame.sessionId) { this.lease.clear(frame.agentThreadId); thread.active?.controller.abort(); thread.queue.length = 0; thread.question = undefined; }
    thread.frame = frame;
    const question = thread.question;
    if (question) {
      const reply = frame.messages.find(m => m.id === frame.triggerMessageId && m.kind === 'human' && (!question.userId || question.userId === m.authorId));
      if (reply) {
        let answers: Record<string, unknown>;
        if (question.questions.length === 1) answers = { [question.questions[0]!.question]: reply.content };
        else {
          try { answers = JSON.parse(reply.content); } catch { throw new Error('Reply to multiple questions with a JSON object keyed by question text'); }
          if (!answers || Array.isArray(answers) || question.questions.some(q => typeof answers[q.question] !== 'string')) throw new Error('Each question needs a text answer');
        }
        thread.question = undefined; question.resolve(answers); return;
      }
    }
    if (thread.queue.length >= (this.options.maxQueuedMessages ?? 64)) throw new Error('Runtime message queue is full');
    thread.queue.push(frame);
    if (!thread.worker) this.work(thread);
  }
  private work(thread: Thread): void {
    const task = this.drain(thread); thread.worker = task;
    void task.finally(() => { thread.worker = undefined; if (thread.queue.length && !this.closed) this.work(thread); }).catch(e => this.report(e));
  }
  private async drain(thread: Thread): Promise<void> {
    while (thread.queue.length && !this.closed) {
      const sessionId = thread.queue[0]!.sessionId;
      const boundary = thread.queue.findIndex(frame => frame.sessionId !== sessionId);
      const batch = thread.queue.splice(0, boundary === -1 ? thread.queue.length : boundary);
      const frame = batch.at(-1)!;
      const active: Active = { controller: new AbortController(), id: randomUUID() };
      thread.active = active; this.guard();
      const signal = active.controller.signal;
      let idleSynced = false;
      try {
        const saved = this.store.get(frame.agentThreadId);
        if (saved && saved.groupChatId !== frame.groupChatId) throw new Error('Stored session belongs to another GroupChat');
        const cwd = this.cwd;
        const resume = saved?.cwd && cwd && comparableCwd(saved.cwd) !== comparableCwd(cwd) ? undefined : saved?.sessionId;
        let usedTool = false;
        await this.activity(thread, frame, active, 'executing', `Thinking in ${this.options.runtime}…`);
        const contract = this.bridge.getContract();
        if (!contract) throw new Error('Bridge contract is missing');
        const callTool = async (name: string, args: Record<string, unknown>, toolCallId: string = randomUUID()): Promise<ToolCallResult> => {
          signal.throwIfAborted();
          if (active.finishing || thread.active !== active) throw new Error('Turn is completing');
          if (!contract.tools.some(tool => tool.name === name)) throw new Error('Unknown collaboration tool');
          usedTool = true;
          if (name === 'send_message') {
            if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('Message must be nonempty');
            const revision = this.lease.record(frame.agentThreadId, frame.sessionId, { state: 'executing', label: `Thinking in ${this.options.runtime}…` }, signal);
            await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId: `tool:${active.id}:${toolCallId}`, content: args.content, activityAfter: { state: 'executing', label: `Thinking in ${this.options.runtime}…` }, shouldSyncActivity: () => !signal.aborted && thread.active === active && !active.finishing && thread.frame.sessionId === frame.sessionId && this.lease.isCurrent(frame.agentThreadId, revision), signal });
            return { content: '消息已发布到聊天' };
          }
          const result = await this.bridge.rpc('tool.call', { sessionId: frame.sessionId, toolCallId, name, arguments: args }, signal);
          return { content: typeof result.content === 'string' ? result.content : JSON.stringify(result), ...(result.isError ? { isError: true } : {}) };
        };
        const context: TurnContext = { ...contract, deliveryId: frame.deliveryId, prompt: batch.map(resolveThreadPrompt).join('\n\n'), resume, signal, turnId: active.id,
          session: async id => { signal.throwIfAborted(); if (!id) throw new Error('Empty runtime session id'); await this.store.set(frame.agentThreadId, { sessionId: id, groupChatId: frame.groupChatId, updatedAt: new Date().toISOString(), cwd }); },
          activity: (state, label) => this.activity(thread, frame, active, state, label),
          callTool,
          send: async (content, toolCallId) => { const result = await callTool('send_message', { content }, toolCallId); if (result.isError) throw new Error(result.content); },
          history: async (limit = 50, offset = 0) => callTool('chat_history', { limit, offset }),
          permission: (tool, input, toolSignal) => { usedTool = true; return this.permission(thread, frame, active, tool, input, toolSignal); },
        };
        try { await this.runner(context); }
        catch (error) {
          if (!resume || signal.aborted || usedTool || !RuntimeMissingResultError.canRetry(error)) throw error;
          await this.store.delete(frame.agentThreadId);
          signal.throwIfAborted();
          await this.runner({ ...context, resume: undefined });
        }
        signal.throwIfAborted();
        active.finishing = true;
        this.lease.clear(frame.agentThreadId);
        await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId: `turn:${frame.agentThreadId}:${active.id}`, content: undefined, activityAfter: { state: 'idle', deliveryId: frame.deliveryId }, shouldSyncActivity: () => thread.active === active && thread.frame.sessionId === frame.sessionId, signal });
        idleSynced = true;
      } catch (error) {
        active.finishing = true;
        if (!signal.aborted) {
          this.report(error); this.lease.clear(frame.agentThreadId);
          const errorMessage = error instanceof Error ? error.message : String(error);
          try {
            await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId: `turn:${frame.agentThreadId}:${active.id}`, content: undefined, activityAfter: { state: 'idle', deliveryId: frame.deliveryId, errorMessage }, shouldSyncActivity: () => thread.active === active && thread.frame.sessionId === frame.sessionId, signal });
            idleSynced = true;
          } catch (queueError) {
            if (!signal.aborted) { idleSynced = true; this.report(queueError); await this.activity(thread, frame, active, 'idle', undefined, errorMessage).catch(e => this.report(e)); }
          }
        }
      } finally {
        this.lease.clear(frame.agentThreadId);
        active.controller.abort(); thread.question = undefined;
        await this.cancelCards(thread, active);
        if (!idleSynced && frame.sessionId === thread.frame.sessionId && thread.active === active) await this.activity(thread, frame, active, 'idle').catch(e => this.report(e));
        if (thread.active === active) thread.active = undefined;
        this.guard();
      }
    }
  }
  private async permission(thread: Thread, frame: ThreadMessage, active: Active, tool: string, input: Record<string, unknown>, toolSignal?: AbortSignal): Promise<PermissionDecision> {
    const signal = toolSignal ? AbortSignal.any([active.controller.signal, toolSignal]) : active.controller.signal;
    signal.throwIfAborted();
    if (tool === 'AskUserQuestion') return this.question(thread, frame, active, input, signal);
    if (this.options.fullAuto) return { behavior: 'allow', updatedInput: input };
    const cardId = `agent_bridge:${this.bridge.credentials.teamId}:approval:${randomUUID()}`;
    const args = { agentThreadId: frame.agentThreadId, turnId: active.id, tool, input };
    await this.activity(thread, frame, active, 'waiting', '等待确认');
    let settle!: (value: boolean) => void;
    const decision = new Promise<boolean>(resolve => { settle = resolve; });
    const card: PendingCard = { thread, active, args, resolve: settle }; this.cards.set(cardId, card);
    const deny = () => { if (this.cards.get(cardId) === card) { this.cards.delete(cardId); settle(false); } };
    const timer = setTimeout(deny, this.options.approvalTimeoutMs ?? 300_000);
    signal.addEventListener('abort', deny, { once: true });
    try {
      await this.bridge.rpc('card.upsert', { sessionId: frame.sessionId, toolCallId: cardId, cardId, title: `Allow ${this.options.runtime}: ${tool}?`, subtitle: tool, description: JSON.stringify(input, null, 2).slice(0, 48_000), actionLabel: '允许执行', verifyToolName: this.options.approvalTool, verifyArguments: args }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      if (signal.aborted) deny();
      const accepted = await decision;
      return accepted && !signal.aborted ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not approved by Nia Teams' };
    } catch (error) { this.report(error); return { behavior: 'deny', message: 'Nia Teams approval unavailable' }; }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', deny); this.cards.delete(cardId);
      await this.bridge.rpc('card.cancel', { sessionId: frame.sessionId, cardId }, AbortSignal.timeout(5000)).catch(e => this.report(e));
      if (!signal.aborted) await this.activity(thread, frame, active, 'executing', `Thinking in ${this.options.runtime}…`).catch(e => this.report(e));
    }
  }
  private async question(thread: Thread, frame: ThreadMessage, active: Active, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionDecision> {
    const questions = input.questions as Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
    if (!Array.isArray(questions) || !questions.length || questions.some(q => typeof q?.question !== 'string')) return { behavior: 'deny', message: 'Invalid question input' };
    if (thread.question) return { behavior: 'deny', message: 'Another question is pending' };
    let done!: (answers?: Record<string, unknown>) => void;
    const wait = new Promise<Record<string, unknown> | undefined>(resolve => { done = resolve; });
    const question = { userId: frame.invokedBy?.userId, questions, resolve: (answers: Record<string, unknown>) => done(answers) };
    thread.question = question;
    const cancel = () => done(); signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.options.approvalTimeoutMs ?? 300_000);
    try {
      const revision = this.lease.record(frame.agentThreadId, frame.sessionId, { state: 'waiting', label: '等待回答' }, signal);
      await this.publications.enqueue({ niaSessionId: frame.sessionId, toolCallId: `question:${active.id}:${randomUUID()}`, content: questions.map(q => `${q.question}\n${(q.options ?? []).map(o => `- ${o.label}${o.description ? ': ' + o.description : ''}`).join('\n')}`).join('\n\n') + (questions.length > 1 ? '\nReply with a JSON object keyed by question text.' : '\nReply in this GroupChat to answer.'), activityAfter: { state: 'waiting', label: '等待回答' }, shouldSyncActivity: () => !signal.aborted && thread.question === question && thread.active === active && !active.finishing && thread.frame.sessionId === frame.sessionId && this.lease.isCurrent(frame.agentThreadId, revision), signal });
      const answers = await wait;
      return answers && !signal.aborted ? { behavior: 'allow', updatedInput: { ...input, answers } } : { behavior: 'deny', message: 'Question canceled or timed out' };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); if (thread.question === question) thread.question = undefined; }
  }
  private async action(action: CardAction): Promise<void> {
    const card = this.cards.get(action.cardId);
    if (!card || card.active.controller.signal.aborted || card.thread.frame.sessionId !== action.sessionId || card.thread.frame.agentThreadId !== action.agentThreadId || card.thread.frame.groupChatId !== action.groupChatId) return;
    let accepted = false;
    if (action.decision === 'approved') {
      try { await this.bridge.verifyCardApproval(action._meta, { server: 'agent-bridge', tool: this.options.approvalTool, arguments: card.args, expectedCardId: action.cardId }); accepted = true; }
      catch (error) { this.report(error); }
    }
    if (this.cards.get(action.cardId) !== card) return;
    this.cards.delete(action.cardId); card.resolve(accepted && !card.active.controller.signal.aborted);
  }
  private async cancelCards(thread: Thread, active: Active): Promise<void> {
    for (const [id, card] of this.cards) if (card.thread === thread && card.active === active) { this.cards.delete(id); card.resolve(false); }
  }
  cancel(frame: ThreadCancel): void {
    const thread = this.threads.get(frame.agentThreadId);
    if (!thread || thread.frame.sessionId !== frame.sessionId) return;
    thread.queue.length = 0; thread.active?.controller.abort();
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const off of this.unregister) off();
    for (const thread of this.threads.values()) { thread.queue.length = 0; thread.active?.controller.abort(); }
    this.lease.close(); this.publications.close(); this.sleep.close();
    await Promise.all([...this.threads.values()].map(t => t.worker));
  }
}
