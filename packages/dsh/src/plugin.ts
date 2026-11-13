import { formatThreadMessage as formatThread } from '@nia-teams/agent-bridge-core/format';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { ExpectedHumanActionContext } from '@nia-teams/mcp-sdk/auth';
import type { Credentials, ThreadMessage, CardAction, ThreadCancel, RpcMethod } from './types.js';
import type { Agent, AgentHandle, AgentOptions, HostContext, ApprovalRequest, ApprovalOutcome, QuestionRequest, QuestionAnswer, SessionEvent, UserMessage, QuestionIntent } from './dsh-types.js';
import { PublicationQueue } from './publications.js';
import { NIA_GROUP_CHAT_SYSTEM_PROMPT } from './prompt.js';
import { UserQuestionError, formatQuestions, parseQuestionReply } from './questions.js';

export interface PluginConfig {
  configDir?: string; serverUrl?: string; cwd?: string; agentPreset?: string; agentOptions?: AgentOptions;
  /** Explicit host-operator preauthorization; empty by default. Never populated by a one-shot card. */
  sessionAllowTools?: string[];
}
export interface PluginBridge {
  readonly credentials: Credentials;
  start(): Promise<void>; close(): void;
  rpc(method: RpcMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  verifyCardApproval(meta: Record<string, unknown> | undefined, expected: ExpectedHumanActionContext): Promise<unknown>;
  onReady(handler: () => void): () => void;
  onThreadMessage(handler: (frame: ThreadMessage) => void | Promise<void>): () => void;
  onCardAction(handler: (frame: CardAction) => void | Promise<void>): () => void;
  onThreadCancel(handler: (frame: ThreadCancel) => void | Promise<void>): () => void;
}
interface Thread {
  frame: ThreadMessage; handle?: AgentHandle; opening?: Promise<AgentHandle>;
  stop: AbortController; allow: Set<string>;
  activityRevision: number;
  activity: { state: 'executing' | 'waiting' | 'idle'; label?: string; errorMessage?: string };
}
interface CardWait { thread: Thread; sessionId: string; cardId: string; resolve(action: CardAction | undefined): void }
interface QuestionWait { thread: Thread; request: QuestionRequest; resolve(answer: QuestionAnswer): void; reject(error: Error): void }
interface Output { turn: number; texts: string[]; sent: Set<string>; toolSent: boolean }

function missingSession(error: unknown, id: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'ENOENT' || code === 'SESSION_NOT_FOUND' || error.message === `session "${id}" not found`
    || error.message === 'cannot resume: session persistence is not configured (load a dsh-session-persistence backend)';
}
function userMessage(text: string): UserMessage {
  // Matches DSH createUserMessage({ content, source: { kind: 'user' } }): a detached immutable value.
  return Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text })]) as unknown as UserMessage['content'], source: Object.freeze({ kind: 'user' }) });
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

/** Owns every Agent handle, pending human operation, listener and activity lease for this plugin instance. */
export class NiaTeamsHost {
  private readonly threads = new Map<string, Thread>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cards = new Map<string, CardWait>();
  private readonly questions = new Map<string, QuestionWait[]>();
  private readonly publications: PublicationQueue;
  private readonly outputs = new Map<string, Output>();
  private readonly disposers: Array<() => void> = [];
  private readonly lifetime = new AbortController();
  private readonly refresh: ReturnType<typeof setInterval>;
  private disposal?: Promise<void>;
  constructor(private readonly ctx: HostContext, readonly bridge: PluginBridge, private readonly config: PluginConfig = {}) {
    this.publications = new PublicationQueue(bridge);
    this.disposers.push(
      bridge.onThreadMessage(frame => this.enqueue(frame.agentThreadId, () => this.message(frame))),
      bridge.onThreadCancel(frame => this.enqueue(frame.agentThreadId, () => this.cancel(frame))),
      bridge.onCardAction(frame => { const wait = this.cards.get(frame.cardId); if (wait && frame.sessionId === wait.sessionId && frame.agentThreadId === wait.thread.frame.agentThreadId && frame.groupChatId === wait.thread.frame.groupChatId) wait.resolve(frame); }),
      ctx.on('approval/request', (request, next) => this.approval(request, next), { global: true, prepend: true }),
      ctx.on('user-questions/request', (request, next) => this.question(request, next), { global: true, prepend: true }),
      ctx.on('session/event', (session, event) => this.event(session.id, event).catch(error => this.warn(error)), { global: true }),
    );
    ctx.inject(['tools'], toolCtx => {
      if (this.lifetime.signal.aborted) return;
      for (const kind of ['send_message', 'history'] as const) {
        const remove = toolCtx.tools.register({
          name: `nia_group_chat_${kind}`,
          description: kind === 'send_message'
            ? 'Publish an immediate mid-turn message (Markdown, inline Rich HTML using var(--*) theme CSS variables, and <mention userId="24-hex-id" />) to the current Nia Teams GroupChat while continuing tool execution. Single-step final replies are published automatically at turn end.'
            : 'Read older messages from the current group chat.',
          parameters: kind === 'send_message'
            ? { type: 'object', properties: { content: { type: 'string', description: 'Message body supporting Markdown, Rich HTML, and <mention userId="24-hex-id" /> tags.' } }, required: ['content'], additionalProperties: false }
            : { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args, exec) => {
            const thread = exec.agent && this.threadForAgent(exec.agent);
            if (!thread) throw new Error('This Agent does not own a Nia Teams GroupChat');
            if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
            const input = args as { content?: string; limit?: number; offset?: number };
            if (kind === 'send_message') {
              if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('content must not be empty');
              const result = await this.sendMessage(thread, input.content, exec.callId, exec.signal);
              const output = this.outputs.get(exec.agent!.id);
              if (output) { output.sent.add(input.content.trim()); output.texts = []; output.toolSent = true; }
              return {
                ...result,
                note: 'Published to GroupChat. If you have no more tool calls to run in this turn, respond with a short internal word like "Done." to close the turn cleanly (it stays private and will not be sent to the GroupChat).',
              };
            }
            const limit = input.limit ?? 50; const offset = input.offset ?? 0;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('History requires limit 1..100 and a non-negative offset');
            return this.bridge.rpc('group_chat.history', { sessionId: thread.frame.sessionId, limit, offset }, exec.signal);
          },
        }, { when: ({ agent }) => this.ownsAgent(agent) });
        // Also explicitly dispose on owner shutdown, not just on service-fiber removal.
        this.disposers.push(remove); toolCtx.effect(() => remove);
      }
    });
    this.refresh = setInterval(() => {
      for (const thread of this.threads.values()) if (thread.activity.state !== 'idle') void this.activity(thread, thread.activity).catch(error => this.warn(error));
    }, 30_000);
  }
  private warn(error: unknown): void { this.ctx.logger.warn(`Nia Teams: ${error instanceof Error ? error.message : String(error)}`); }
  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      this.lifetime.signal.throwIfAborted(); return operation();
    });
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  private threadForAgent(agent: Agent): Thread | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined;
    for (const thread of this.threads.values()) {
      const root = thread.handle?.agent;
      if (!root || this.ctx.agents.get(root.id) !== root) continue;
      const candidates = [root]; const visited = new Set<Agent>();
      while (candidates.length) {
        const parent = candidates.pop()!;
        if (visited.has(parent)) continue;
        visited.add(parent);
        if (agent === parent || this.ctx.agents.isOwnedBy(agent.id, parent)) return thread;
        candidates.push(...this.ctx.agents.list().filter(child => this.ctx.agents.isOwnedBy(child.id, parent)));
      }
    }
    return undefined;
  }
  ownsAgent(agent: Agent): boolean { return this.threadForAgent(agent) !== undefined; }
  private signal(thread: Thread, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, thread.stop.signal, ...(signal ? [signal] : [])]);
  }
  private resolveAgentOptions(): AgentOptions | undefined {
    if (this.config.agentOptions?.provider && this.config.agentOptions?.model) return this.config.agentOptions;
    const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection();
    if (!selection) return undefined;
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    };
  }
  private async open(thread: Thread): Promise<AgentHandle> {
    if (thread.handle && this.ctx.agents.get(thread.handle.agent.id) === thread.handle.agent) return thread.handle;
    if (thread.opening) return thread.opening;
    thread.opening = (async () => {
      const presets = this.ctx.get?.('agentPresets');
      const presetId = presets ? (await presets.resolve(this.config.agentPreset)).id : undefined;
      const agentOptions = this.resolveAgentOptions();
      const setup = async (agentCtx: unknown, agent: Agent) => {
        const scopedCtx = agentCtx as { on?: (event: string, fn: (...args: never[]) => unknown) => void };
        if (agentOptions?.provider && agentOptions?.model) {
          agent.model?.select?.({
            provider: agentOptions.provider,
            model: agentOptions.model,
            ...(agentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptions.reasoningEffort }),
          });
          scopedCtx.on?.(
            'agent/request',
            (async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
              const resolved = await next();
              const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
              return {
                ...rest,
                provider: agentOptions.provider!,
                model: agentOptions.model!,
                ...(agentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptions.reasoningEffort }),
              };
            }) as never,
          );
        }
        scopedCtx.on?.(
          'system-prompt/assemble',
          (async (
            _assembly: unknown,
            _context: unknown,
            next: () => Promise<{
              sections?: Array<{ name: string; text: string; interpolate?: boolean }>;
              variables?: Record<string, string>;
            }>,
          ) => {
            const assembled = await next();
            const sections = Array.isArray(assembled.sections)
              ? [
                  ...assembled.sections.filter(section => section.name !== 'nia-teams:group-chat'),
                  { name: 'nia-teams:group-chat', text: NIA_GROUP_CHAT_SYSTEM_PROMPT, interpolate: false },
                ]
              : [{ name: 'nia-teams:group-chat', text: NIA_GROUP_CHAT_SYSTEM_PROMPT, interpolate: false }];
            return {
              ...assembled,
              sections,
              ...(agentOptions?.provider && agentOptions?.model
                ? {
                    variables: {
                      ...assembled.variables,
                      provider: agentOptions.provider,
                      model: agentOptions.model,
                    },
                  }
                : {}),
            };
          }) as never,
        );
        if (presets && presetId) await presets.mount(agentCtx, presetId);
      };
      let handle: AgentHandle;
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: thread.frame.agentThreadId,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          setup,
        });
      } catch (error) {
        if (!missingSession(error, thread.frame.agentThreadId)) throw error;
        this.lifetime.signal.throwIfAborted();
        const cwd = this.config.cwd ?? process.cwd();
        await mkdir(cwd, { recursive: true });
        handle = await this.ctx.agents.create({
          sessionId: thread.frame.agentThreadId,
          meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
          ...(agentOptions === undefined ? {} : { agentOptions }),
          setup,
        });
      }
      if (this.lifetime.signal.aborted) { await handle.dispose(); throw new Error('Nia Teams plugin disposed'); }
      thread.handle = handle; return handle;
    })();
    try { return await thread.opening; } finally { thread.opening = undefined; }
  }
  private async message(frame: ThreadMessage): Promise<void> {
    let thread = this.threads.get(frame.agentThreadId);
    if (!thread) {
      thread = { frame, stop: new AbortController(), allow: new Set(this.config.sessionAllowTools ?? []), activityRevision: 0, activity: { state: 'idle' } };
      this.threads.set(frame.agentThreadId, thread);
    } else {
      thread.frame = frame;
      if (thread.stop.signal.aborted) thread.stop = new AbortController();
    }
    const pending = this.questions.get(frame.agentThreadId)?.[0];
    if (pending) {
      const reply = frame.messages.find(message => message.id === frame.triggerMessageId && message.kind === 'human');
      if (reply) {
        const parsed = parseQuestionReply(pending.request.questions, reply.content);
        if (parsed) { pending.resolve(parsed); return; }
        await this.sendMessage(thread, 'Please answer each question on a separate line (for example Q1=1).', `question-retry:${frame.deliveryId}`);
        return;
      }
      // Non-human pushes cannot answer the human question or enqueue a duplicate followup.
      return;
    }
    const handle = await this.open(thread);
    const pendingCards = [...this.cards.values()].filter(wait => wait.thread === thread);
    if (pendingCards.length > 0) {
      await Promise.allSettled(pendingCards.map(wait => {
        wait.resolve(undefined);
        return this.bridge.rpc('card.cancel', { sessionId: wait.sessionId, cardId: wait.cardId });
      }));
      if (typeof handle.agent.steer === 'function') {
        handle.agent.steer(userMessage(formatThread(frame)));
        return;
      }
    }
    handle.agent.followup(userMessage(formatThread(frame)));
  }
  private async cancel(frame: ThreadCancel): Promise<void> {
    const thread = this.threads.get(frame.agentThreadId);
    if (!thread) return;
    thread.stop.abort();
    await thread.handle?.agent.cancel?.({ kind: 'user' });
    await this.activity(thread, { state: 'idle' }).catch(error => this.warn(error));
    if (frame.reason === 'removed_from_group') {
      await thread.handle?.dispose(); this.threads.delete(frame.agentThreadId);
    }
  }
  private setActivity(thread: Thread, value: Thread['activity']): number {
    if (thread.activity !== value) thread.activityRevision++;
    thread.activity = value;
    return thread.activityRevision;
  }
  private activity(thread: Thread, value: Thread['activity']): Promise<unknown> {
    this.setActivity(thread, value);
    return this.bridge.rpc('thread.activity', { sessionId: thread.frame.sessionId, ...value });
  }
  private sendMessage(thread: Thread, content: string, toolCallId: string, signal?: AbortSignal) {
    return this.bridge.rpc('group_chat.send_message', { sessionId: thread.frame.sessionId, content, toolCallId }, signal);
  }
  private async event(sessionId: string, event: SessionEvent): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const agent = this.ctx.agents.get(sessionId);
    const thread = agent && this.threadForAgent(agent);
    if (!thread) return;
    // Child approvals/activity belong to the same GroupChat, but child final output is private to the parent.
    const rootEvent = thread.handle?.agent === agent;
    const data = event.data;
    if (event.type === 'turn/start') {
      this.outputs.set(sessionId, { turn: data.turn ?? 0, texts: [], sent: new Set(), toolSent: false });
      await this.activity(thread, { state: 'executing', label: 'Thinking…' });
    } else if (event.type === 'tool/call') {
      await this.activity(thread, { state: 'executing', label: `Running ${data.name ?? data.toolName ?? 'tool'}…` });
    } else if (event.type === 'assistant/message' && !data.interrupted && !data.message?.interrupted) {
      const text = assistantText(data.message?.content ?? data.content).trim();
      const output = this.outputs.get(sessionId);
      if (output && text && output.turn === (data.turn ?? output.turn) && !output.sent.has(text)) output.texts.push(text);
    } else if (event.type === 'turn/end') {
      const output = this.outputs.get(sessionId);
      const alreadySentViaTool = Boolean(output && output.turn === data.turn && output.toolSent);
      const text = output && output.turn === data.turn && !alreadySentViaTool ? output.texts.join('\n\n').trim() : '';
      const interrupted = data.reason?.kind === 'aborted' || data.reason?.kind === 'interrupted';
      const silentPostToolStop = alreadySentViaTool && data.reason?.kind === 'error' && data.reason.error?.code === 'EMPTY_RESPONSE';
      if (rootEvent) {
        const niaSessionId = thread.frame.sessionId;
        const activityAfter = {
          state: 'idle' as const,
          ...(data.reason?.kind === 'error' && !silentPostToolStop
            ? { errorMessage: data.reason.error?.message ?? 'Agent turn failed' }
            : {}),
        };
        const revision = this.setActivity(thread, activityAfter);
        const completion = this.publications.enqueue({ niaSessionId, toolCallId: `turn:${sessionId}:${data.turn}`,
          content: text && !interrupted ? text : undefined, activityAfter,
          shouldSyncActivity: () => thread.frame.sessionId !== niaSessionId || thread.activityRevision === revision,
        });
        void completion.catch(error => { if (!this.lifetime.signal.aborted) this.warn(error); });
        // Ownership of unsent content transfers to the retry queue before the turn buffer is released.
        this.outputs.delete(sessionId);
        // Wait for this attempt, not for an indefinite outage: the queue owns reconnect retries.
        await this.publications.flush();
      } else this.outputs.delete(sessionId);
    }
  }
  private async card(thread: Thread, tool: string, args: Record<string, unknown>, details: { title: string; subtitle: string; description?: string; callId?: string }, callerSignal?: AbortSignal): Promise<'approved' | 'rejected' | 'cancelled'> {
    const signal = this.signal(thread, callerSignal);
    if (signal.aborted) return 'cancelled';
    const sessionId = thread.frame.sessionId;
    const cardId = `agent_bridge:${this.bridge.credentials.teamId}:${thread.frame.agentThreadId}:${details.callId || randomUUID()}`;
    if (this.cards.has(cardId)) return 'rejected';
    let settle!: (value: CardAction | undefined) => void;
    const actionPromise = new Promise<CardAction | undefined>(resolve => { settle = resolve; });
    const aborted = (): void => { settle(undefined); void this.bridge.rpc('card.cancel', { sessionId, cardId }).catch(error => this.warn(error)); };
    this.cards.set(cardId, { thread, sessionId, cardId, resolve: settle });
    signal.addEventListener('abort', aborted, { once: true });
    try {
      await this.bridge.rpc('card.upsert', { sessionId, toolCallId: details.callId || cardId, cardId, title: details.title, subtitle: details.subtitle,
        ...(details.description ? { description: details.description } : {}), actionLabel: '允许执行', verifyToolName: tool, verifyArguments: args });
      if (signal.aborted) { await this.bridge.rpc('card.cancel', { sessionId, cardId }).catch(error => this.warn(error)); return 'cancelled'; }
      await this.activity(thread, { state: 'waiting', label: '等待确认' });
      const action = await actionPromise;
      if (signal.aborted || !action) return 'cancelled';
      if (action.decision !== 'approved') return 'rejected';
      try {
        await this.bridge.verifyCardApproval(action._meta, { server: 'agent-bridge', tool, arguments: args, expectedCardId: cardId });
      } catch { return 'rejected'; }
      if (signal.aborted) return 'cancelled';
      return 'approved';
    } catch (error) {
      this.warn(error);
      // An upsert may have reached the server even if its RPC response was lost.
      await this.bridge.rpc('card.cancel', { sessionId, cardId }).catch(() => {});
      return signal.aborted ? 'cancelled' : 'rejected';
    } finally {
      signal.removeEventListener('abort', aborted); this.cards.delete(cardId);
      if (!signal.aborted) await this.activity(thread, { state: 'executing', label: 'Thinking…' }).catch(error => this.warn(error));
    }
  }
  private async approval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const thread = this.threadForAgent(request.agent);
    if (!thread) return next();
    if (this.signal(thread, request.signal).aborted) return 'cancelled';
    if (thread.allow.has(request.toolName)) return 'allowed-once';
    const result = await this.card(thread, 'dsh.approval', { agentThreadId: thread.frame.agentThreadId, toolName: request.toolName, callId: request.callId ?? '', reason: request.reason ?? '' },
      { title: `Allow ${request.toolName}?`, subtitle: request.reason || 'This Agent needs permission to continue.', callId: request.callId }, request.signal);
    if (result === 'approved') {
      await this.activity(thread, { state: 'executing', label: `Running ${request.toolName}…` }).catch(error => this.warn(error));
      return 'allowed-once';
    }
    return result;
  }
  private async question(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const thread = request.agent && this.threadForAgent(request.agent);
    if (!thread) return next();
    const intent = request.intent ?? request.questions.find(q => q.intent?.kind === 'approval')?.intent;
    if (intent?.kind === 'approval') {
      if (!request.intent && request.questions.some(q => q.intent?.kind !== 'approval')) {
        throw new UserQuestionError('Approval and ordinary questions must be asked separately', 'BAD_ANSWER');
      }
      const result = await this.card(thread, 'dsh.question_approval', { agentThreadId: thread.frame.agentThreadId, questionIds: request.questions.map(q => q.id) }, {
        title: 'Agent permission request', subtitle: request.questions.map(q => q.question).join('\n'),
        description: request.questions.map(q => q.detail).filter(Boolean).join('\n\n'), callId: request.wait?.callId,
      }, request.signal);
      if (result === 'cancelled') throw new UserQuestionError('The permission request was aborted', 'ASK_ABORTED');
      return { answers: request.questions.map(question => {
        const choices = question.options ?? [];
        const ownIntent: QuestionIntent = question.intent ?? intent;
        const deny = choices.find(option => option.label === ownIntent.reject) ?? choices.find(option => /^(deny|reject|cancel|no)(\b|$)/i.test(option.label));
        const allow = choices.find(option => option.label === ownIntent.approve) ?? choices.find(option => /allow for this session/i.test(option.label)) ?? choices.find(option => option !== deny);
        const option = result === 'approved' ? allow : deny;
        if (!option) throw new UserQuestionError('The permission request was dismissed', 'ASK_CANCELLED');
        return { id: question.id, selected: [option.label] };
      }) };
    }
    const signal = this.signal(thread, request.signal);
    if (signal.aborted) throw new UserQuestionError('Question aborted', 'ASK_ABORTED');
    const id = thread.frame.agentThreadId;
    let wait!: QuestionWait;
    const removeWait = (): void => {
      const queue = this.questions.get(id);
      if (queue) { const index = queue.indexOf(wait); if (index >= 0) queue.splice(index, 1); if (!queue.length) this.questions.delete(id); }
    };
    const answer = new Promise<QuestionAnswer>((resolve, reject) => { wait = { thread, request,
      resolve: value => { removeWait(); resolve(value); }, reject: error => { removeWait(); reject(error); },
    }; });
    // Attach rejection immediately: cancellation can precede the send RPC response.
    void answer.catch(() => {});
    const pending = this.questions.get(id) ?? [];
    pending.push(wait); this.questions.set(id, pending);
    const aborted = (): void => wait.reject(new UserQuestionError('Question aborted', 'ASK_ABORTED'));
    signal.addEventListener('abort', aborted, { once: true });
    const publicationStop = new AbortController();
    try {
      const niaSessionId = thread.frame.sessionId;
      const activityAfter = { state: 'waiting' as const, label: '等待回复' };
      const revision = this.setActivity(thread, activityAfter);
      const publication = this.publications.enqueue({ niaSessionId,
        toolCallId: request.wait?.callId ?? `question:${randomUUID()}`,
        content: formatQuestions(request.questions, thread.frame.invokedBy?.userId), activityAfter,
        shouldSyncActivity: () => !signal.aborted && thread.activityRevision === revision,
        signal: AbortSignal.any([signal, publicationStop.signal]),
      });
      // A reply can arrive after the server accepted a prompt but before its RPC acknowledgment.
      // Consume that reply immediately instead of re-posting an already answered question.
      await Promise.race([publication, answer]);
      return await answer;
    } catch (error) {
      if (signal.aborted) throw new UserQuestionError('Question aborted', 'ASK_ABORTED');
      throw error;
    } finally {
      publicationStop.abort();
      signal.removeEventListener('abort', aborted);
      removeWait();
      if (!signal.aborted) await this.activity(thread, { state: 'executing', label: 'Thinking…' }).catch(error => this.warn(error));
    }
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.lifetime.abort(); this.publications.close(); clearInterval(this.refresh);
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.disposal = (async () => {
      await Promise.allSettled([...this.queues.values(), ...[...this.threads.values()].flatMap(thread => thread.opening ? [thread.opening] : [])]);
      await Promise.allSettled([...this.threads.values()].flatMap(thread => thread.handle ? [thread.handle.dispose()] : []));
      this.bridge.close(); this.threads.clear(); this.outputs.clear(); this.questions.clear(); this.cards.clear();
    })();
    return this.disposal;
  }
}
