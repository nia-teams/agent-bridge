/** Structural subset of DeepSeek Harness 0.2.x. Host services are not npm runtime dependencies. */
export interface UserMessage {
  id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' };
}
export interface Agent {
  id: string; session: { id: string };
  model?: { select?(selection: { provider: string; model: string; reasoningEffort?: string }): void };
  followup(message: UserMessage): void;
  steer?(message: UserMessage): void;
  cancel?(reason?: { kind: 'user' }): void | Promise<void>;
}
export interface AgentHandle { agent: Agent; dispose(): Promise<void> }
export interface AgentOptions { provider?: string; model?: string; reasoningEffort?: string }
export interface QuestionIntent { kind: string; approve?: string; reject?: string; always?: string }
export interface Question {
  id: string; question: string; header?: string; detail?: string;
  options?: Array<{ label: string; description?: string }>; multiSelect?: boolean; intent?: QuestionIntent;
}
export interface QuestionAnswer { answers: Array<{ id: string; selected: string[]; custom?: string }> }
export interface QuestionRequest {
  agent?: Agent; questions: Question[]; signal?: AbortSignal; intent?: QuestionIntent; wait?: { callId: string; timed?: boolean };
}
export interface ApprovalRequest { agent: Agent; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export interface SessionEvent {
  type: string;
  data: {
    turn?: number; name?: string; toolName?: string; interrupted?: boolean;
    message?: { content?: unknown; interrupted?: boolean }; content?: unknown;
    reason?: { kind: string; error?: { message?: string; code?: string } };
  };
}
export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> };
  execute(args: unknown, exec: { agent?: Agent; callId: string; signal: AbortSignal }): Promise<unknown>;
}
export interface HostEvents {
  'approval/request': [ApprovalRequest, () => Promise<ApprovalOutcome>];
  'user-questions/request': [QuestionRequest, () => Promise<QuestionAnswer>];
  'session/event': [{ id: string }, SessionEvent];
}
export interface AgentDefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
}
export interface AgentPresetRegistryService {
  resolve(id?: string): Promise<{ id: string }>;
  mount(ctx: unknown, id?: string): Promise<unknown>;
}
export interface HostServices {
  agentDefaultModel?: AgentDefaultModelService;
  agentPresets?: AgentPresetRegistryService;
}
export interface HostContext {
  agents: {
    create(options: { sessionId: string; meta: { cwd: string; agentPreset?: string }; agentOptions?: AgentOptions; setup?: (agentCtx: unknown, agent: Agent) => void | Promise<void> }): Promise<AgentHandle>;
    resume(options: { resumeSessionId: string; agentOptions?: AgentOptions; setup?: (agentCtx: unknown, agent: Agent) => void | Promise<void> }): Promise<AgentHandle>;
    isOwnedBy(id: string, parent: Agent): boolean;
    get(id: string): Agent | undefined;
    list(): Agent[];
  };
  get?<K extends keyof HostServices>(name: K): HostServices[K] | undefined;
  on<K extends keyof HostEvents>(event: K, handler: (...args: HostEvents[K]) => unknown, options?: { global?: boolean; prepend?: boolean }): () => void;
  effect(body: () => (() => void | Promise<void>)): () => void;
  inject(services: string[], callback: (ctx: ToolContext) => void): unknown;
  logger: { warn(message: string): void };
}
export interface ToolContext {
  tools: { register(definition: ToolDefinition, options?: { when?: (context: { agent: Agent }) => boolean }): () => void };
  effect(body: () => (() => void | Promise<void>)): () => void;
}
