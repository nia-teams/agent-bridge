import { formatThreadMessage as formatThread } from '@nia-teams/agent-bridge-core/format';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { BridgeClient } from './bridge-client.js';
import { PublicationQueue } from './publications.js';
import { NIA_CHANNEL_INSTRUCTIONS } from './prompt.js';
import type { ThreadMessage, CardAction, ThreadCancel } from './types.js';

export const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string().trim().min(1).max(128), tool_name: z.string().min(1), description: z.string(), input_preview: z.string() }),
});
type PermissionRequest = z.infer<typeof PermissionRequestSchema>['params'];
type Activity = { state: 'idle' | 'executing' | 'waiting'; label?: string };
interface Thread { frame: ThreadMessage; activity: Activity; order: number; revision: number; stop: AbortController }
interface CardWait {
  thread: Thread; groupChatId: string; sessionId: string; agentThreadId: string; cardId: string;
  request: PermissionRequest; arguments: Record<string, unknown>; timer: ReturnType<typeof setTimeout>;
}
const working: Activity = { state: 'executing', label: 'Working in Claude Code…' };
const id = z.string().regex(/^[a-f\d]{24}$/i);
const sendInput = z.object({ group_chat_id: id, content: z.string().trim().min(1), keep_working: z.boolean().optional() }).strict();
const historyInput = z.object({ group_chat_id: id, limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict();

export { formatThreadMessage as formatThread } from '@nia-teams/agent-bridge-core/format';


/** One Claude Code session; GroupChats share the host context, not isolated model sessions. */
export class ChannelServer {
  readonly mcp: Server;
  private readonly threads = new Map<string, Thread>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly cards = new Map<string, CardWait>();
  private readonly requests = new Set<string>();
  private readonly publications: PublicationQueue;
  private readonly disposers: Array<() => void> = [];
  private readonly refresh: ReturnType<typeof setInterval>;
  private activeGroupChatId?: string;
  private order = 0;
  private closing = false;
  private disposal?: Promise<void>;
  constructor(readonly bridge: BridgeClient, private readonly log: (message: string) => void = message => console.error(`Nia Teams: ${message}`)) {
    this.mcp = new Server({ name: 'nia-teams', version: '0.1.0' }, {
      capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
      instructions: NIA_CHANNEL_INSTRUCTIONS,
    });
    this.publications = new PublicationQueue(bridge);
    this.disposers.push(
      bridge.onThreadMessage(frame => this.enqueue(frame.groupChatId, () => this.message(frame))),
      bridge.onCardAction(frame => this.cardAction(frame)),
      bridge.onThreadCancel(frame => this.enqueue(frame.groupChatId, () => this.cancel(frame))),
      bridge.onReady(() => { for (const thread of this.threads.values()) if (thread.activity.state !== 'idle') void this.activity(thread, thread.activity); }),
    );
    this.mcp.setNotificationHandler(PermissionRequestSchema, ({ params }) => this.permission(params));
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'nia_group_chat_send_message', description: 'Publish a GroupChat reply. Terminal text is private. Pass group_chat_id from the channel block. Use keep_working: true for interim updates; omit it on the final reply to mark idle.', inputSchema: {
        type: 'object', properties: { group_chat_id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' }, content: { type: 'string', minLength: 1 }, keep_working: { type: 'boolean', default: false } }, required: ['group_chat_id', 'content'], additionalProperties: false,
      } },
      { name: 'nia_group_chat_history', description: 'Read paginated history for a tracked GroupChat.', inputSchema: {
        type: 'object', properties: { group_chat_id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } }, required: ['group_chat_id'], additionalProperties: false,
      } },
    ] }));
    this.mcp.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        if (this.closing) throw new Error('Channel is closing');
        if (request.params.name === 'nia_group_chat_send_message') {
          const input = sendInput.parse(request.params.arguments);
          const thread = this.thread(input.group_chat_id);
          const sessionId = thread.frame.sessionId;
          const activityAfter: Activity = input.keep_working ? working : { state: 'idle' };
          const revision = ++thread.revision;
          await this.publications.enqueue({ niaSessionId: sessionId, toolCallId: randomUUID(), content: input.content, activityAfter,
            signal: thread.stop.signal,
            shouldSyncActivity: () => {
              if (thread.frame.sessionId !== sessionId || thread.revision !== revision || thread.stop.signal.aborted) return false;
              thread.activity = activityAfter; return true;
            },
          });
          return { content: [{ type: 'text', text: 'Published to GroupChat.' }] };
        }
        if (request.params.name === 'nia_group_chat_history') {
          const input = historyInput.parse(request.params.arguments);
          const result = await bridge.rpc('group_chat.history', { sessionId: this.thread(input.group_chat_id).frame.sessionId, limit: input.limit, offset: input.offset });
          return { content: [{ type: 'text', text: typeof result.text === 'string' ? result.text : JSON.stringify(result) }] };
        }
        throw new Error(`Unknown tool: ${request.params.name}`);
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
    });
    this.refresh = setInterval(() => {
      for (const thread of this.threads.values()) if (thread.activity.state !== 'idle') void this.activity(thread, thread.activity);
    }, 30_000);
    this.refresh.unref();
  }
  async connect(transport: Transport): Promise<void> { await this.mcp.connect(transport); await this.bridge.start(); }
  private enqueue(groupChatId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.operations.get(groupChatId) ?? Promise.resolve()).catch(() => {}).then(async () => { if (!this.closing) await operation(); });
    this.operations.set(groupChatId, next);
    void next.finally(() => { if (this.operations.get(groupChatId) === next) this.operations.delete(groupChatId); }).catch(() => {});
    return next;
  }
  private thread(groupChatId: string): Thread {
    const thread = this.threads.get(groupChatId);
    if (!thread) throw new Error('Unknown GroupChat; wait for an inbound message first');
    return thread;
  }
  private async activity(thread: Thread, activity: Activity): Promise<void> {
    thread.activity = activity;
    await this.bridge.rpc('thread.activity', { sessionId: thread.frame.sessionId, ...activity }, AbortSignal.timeout(1500)).catch(error => this.log(String(error)));
  }
  private async message(frame: ThreadMessage): Promise<void> {
    if (this.closing) return;
    let thread = this.threads.get(frame.groupChatId);
    if (thread && thread.frame.sessionId !== frame.sessionId) {
      thread.stop.abort();
      await this.cancelCards(thread);
      thread.stop = new AbortController();
    }
    if (!thread) { thread = { frame, activity: working, order: 0, revision: 0, stop: new AbortController() }; this.threads.set(frame.groupChatId, thread); }
    thread.frame = frame; thread.order = ++this.order; thread.revision++;
    this.activeGroupChatId = frame.groupChatId;
    await this.activity(thread, working);
    if (this.closing) return;
    await this.mcp.notification({ method: 'notifications/claude/channel', params: {
      content: formatThread(frame), meta: { source: 'nia_teams', group_chat_id: frame.groupChatId, session_id: frame.sessionId, agent_thread_id: frame.agentThreadId,
        trigger_message_id: frame.triggerMessageId, reason: frame.reason, sender_id: frame.invokedBy?.userId ?? '', sender_name: frame.invokedBy?.userName ?? '' },
    } });
  }
  private async permission(request: PermissionRequest): Promise<void> {
    if (this.closing || this.requests.has(request.request_id)) return;
    const thread = [...this.threads.values()].filter(t => t.activity.state === 'executing' && !t.stop.signal.aborted).sort((a, b) => b.order - a.order)[0]
      ?? (this.activeGroupChatId ? this.threads.get(this.activeGroupChatId) : undefined);
    if (!thread || thread.stop.signal.aborted) { this.log('No GroupChat context for permission request; use the local terminal.'); return; }
    this.requests.add(request.request_id);
    const { groupChatId, sessionId, agentThreadId } = thread.frame;
    const cardId = `agent_bridge:${this.bridge.credentials.teamId}:${agentThreadId}:perm:${request.request_id}:${randomUUID().slice(0, 8)}`;
    if (cardId.length > 200) { await this.verdict(request.request_id, 'deny'); return; }
    const args = { agentThreadId, requestId: request.request_id, toolName: request.tool_name, description: request.description, inputPreview: request.input_preview };
    const timer = setTimeout(() => { void this.finishCard(cardId, 'deny', true).catch(error => this.log(String(error))); }, 300_000);
    timer.unref();
    const wait: CardWait = { thread, groupChatId, sessionId, agentThreadId, cardId, request, arguments: args, timer };
    this.cards.set(cardId, wait);
    try {
      await this.bridge.rpc('card.upsert', { sessionId, toolCallId: `perm:${request.request_id}`, cardId, title: `Allow ${request.tool_name}?`,
        subtitle: request.description || `Claude Code requested permission to run ${request.tool_name}.`,
        ...(request.input_preview ? { description: request.input_preview } : {}), actionLabel: '允许执行', verifyToolName: 'claude_code.permission', verifyArguments: args }, AbortSignal.timeout(5000));
      // Cancellation or a fast action can win while card.upsert is still in flight.
      if (!this.cards.has(cardId)) { await this.cancelRemote(wait); return; }
      thread.revision++;
      await this.activity(thread, { state: 'waiting', label: '等待确认' });
    } catch (error) { this.log(String(error)); await this.finishCard(cardId, 'deny', true); }
  }
  private async verdict(requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
    await this.mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: requestId, behavior } });
  }
  private async cardAction(action: CardAction): Promise<void> {
    const wait = this.cards.get(action.cardId);
    if (!wait || action.sessionId !== wait.sessionId || action.agentThreadId !== wait.agentThreadId || action.groupChatId !== wait.groupChatId) return;
    let behavior: 'allow' | 'deny' = 'deny';
    if (action.decision === 'approved') {
      try {
        await this.bridge.verifyCardApproval(action._meta, { server: 'agent-bridge', tool: 'claude_code.permission', arguments: wait.arguments, expectedCardId: wait.cardId });
        behavior = 'allow';
      } catch (error) { this.log(`Permission denied: ${String(error)}`); }
    }
    // A concurrent cancel/shutdown invalidates even a successfully verified approval.
    if (this.cards.get(action.cardId) !== wait || this.closing || wait.thread.stop.signal.aborted) return;
    await this.finishCard(action.cardId, behavior);
  }
  private async cancelRemote(wait: CardWait): Promise<void> {
    await this.bridge.rpc('card.cancel', { sessionId: wait.sessionId, cardId: wait.cardId }, AbortSignal.timeout(1000)).catch(error => this.log(String(error)));
  }
  private async finishCard(cardId: string, behavior: 'allow' | 'deny', cancel = false, restore = true): Promise<void> {
    const wait = this.cards.get(cardId);
    if (!wait) return;
    this.cards.delete(cardId); clearTimeout(wait.timer);
    await Promise.allSettled([this.verdict(wait.request.request_id, behavior), ...(cancel ? [this.cancelRemote(wait)] : [])]);
    if (restore && !this.closing && wait.thread.frame.sessionId === wait.sessionId && !wait.thread.stop.signal.aborted) {
      wait.thread.revision++;
      await this.activity(wait.thread, { state: 'executing', label: behavior === 'allow' ? `Running ${wait.request.tool_name}…` : 'Thinking…' });
    }
  }
  private async cancelCards(thread: Thread): Promise<void> {
    await Promise.allSettled([...this.cards.values()].filter(w => w.thread === thread).map(w => this.finishCard(w.cardId, 'deny', true, false)));
  }
  private async cancel(frame: ThreadCancel): Promise<void> {
    const thread = this.threads.get(frame.groupChatId);
    if (!thread || thread.frame.agentThreadId !== frame.agentThreadId || thread.frame.sessionId !== frame.sessionId) return;
    thread.stop.abort(); thread.revision++;
    await this.cancelCards(thread);
    await this.activity(thread, { state: 'idle' });
    if (frame.reason === 'removed_from_group') {
      this.threads.delete(frame.groupChatId);
      if (this.activeGroupChatId === frame.groupChatId) this.activeGroupChatId = [...this.threads.values()].sort((a, b) => b.order - a.order)[0]?.frame.groupChatId;
    } else {
      await this.mcp.notification({ method: 'notifications/claude/channel', params: { content: 'The GroupChat canceled this request. Stop work for this request; do not publish a completion.', meta: { source: 'nia_teams', group_chat_id: frame.groupChatId, session_id: frame.sessionId, agent_thread_id: frame.agentThreadId, reason: 'user_aborted' } } });
      // A later inbound message can begin a fresh operation in this same session.
      thread.stop = new AbortController();
    }
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true; clearInterval(this.refresh); this.publications.close();
    for (const dispose of this.disposers) dispose();
    for (const thread of this.threads.values()) thread.stop.abort();
    this.disposal = (async () => {
      await Promise.allSettled([
        ...[...this.cards.values()].map(w => this.finishCard(w.cardId, 'deny', true, false)),
        ...[...this.threads.values()].filter(t => t.activity.state !== 'idle').map(t => this.activity(t, { state: 'idle' })),
      ]);
      this.bridge.close(); await this.mcp.close(); this.threads.clear();
    })();
    return this.disposal;
  }
}
