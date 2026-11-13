/** Test-only DSH service boundary. The Loader and plugin lifecycle remain real. */
export const name = 'test-host-services';
export function apply(ctx) {
  const agents = new Map(); const tools = new Map(); const follows = []; const disposed = [];
  ctx.provide('agents', {
    get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: () => false,
    resume: async ({ resumeSessionId }) => { throw new Error(`session "${resumeSessionId}" not found`); },
    create: async ({ sessionId }) => {
      const agent = { id: sessionId, session: { id: sessionId }, cancel() {}, followup(message) {
        follows.push(message);
        void (async () => {
          await ctx.parallel('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } });
          await ctx.parallel('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Loaded Agent says hello' }] } } });
          await ctx.parallel('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
        })();
      } };
      agents.set(sessionId, agent);
      return { agent, dispose: async () => { agents.delete(sessionId); disposed.push(sessionId); } };
    },
  });
  ctx.provide('tools', { register: (definition, options) => {
    tools.set(definition.name, { definition, options });
    return () => { tools.delete(definition.name); };
  } });
  ctx.provide('testProbe', { tools, follows, disposed, agents });
}
