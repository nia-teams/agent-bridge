import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, NiaTeamsHost } from '../dist/index.js';
import { fixture, hostContext, message, until, agentThreadId, groupChatId, sessionId, teamId, userId } from './helpers.mjs';
import { parseQuestionReply } from '../dist/questions.js';

async function setup(t, hostOptions, config) {
  const f = await fixture(t); const ctx = hostContext(hostOptions);
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10, onError: error => ctx.calls.warnings.push(error.message) });
  const host = new NiaTeamsHost(ctx, bridge, config);
  t.after(async () => { await host.close(); bridge.close(); });
  await bridge.start();
  f.send(message()); await until(() => ctx.calls.followup.length === 1);
  return { f, ctx, bridge, host, agent: ctx.agents.get(agentThreadId) };
}
function event(ctx, type, data, id = agentThreadId) { return ctx.emit('session/event', { id }, { type, data }); }
async function cardAfter(f, before = 0) { await until(() => f.rpcs.filter(rpc => rpc.method === 'card.upsert').length > before); return f.rpcs.filter(rpc => rpc.method === 'card.upsert').at(-1); }
const approvalQuestion = { id: 'perm', question: 'May I write the file?', intent: { kind: 'approval', approve: 'Allow once', reject: 'Deny' }, options: [{ label: 'Allow once' }, { label: 'Allow for this session' }, { label: 'Deny' }] };

test('thread drives deterministic fresh/resumed sessions, coalesces creation, formats roster and auto-publishes final text', async t => {
  const { f, ctx, host, agent } = await setup(t);
  assert.equal(ctx.calls.resume[0].resumeSessionId, agentThreadId); assert.equal(ctx.calls.create.length, 1);
  assert.ok(host.ownsAgent(agent)); assert.match(ctx.calls.followup[0].message.content[0].text, /Alex \(3456789/);
  assert.equal(ctx.calls.followup[0].message.role, 'user'); assert.ok(Object.isFrozen(ctx.calls.followup[0].message));
  f.send(message('Second')); f.send(message('Third'));
  await until(() => ctx.calls.followup.length === 3); assert.equal(ctx.calls.create.length, 1);
  await event(ctx, 'turn/start', { turn: 1 }); await event(ctx, 'tool/call', { turn: 1, name: 'read_file' });
  await event(ctx, 'assistant/message', { turn: 1, message: { content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Final answer' }] } });
  await event(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  const sent = f.rpcs.find(rpc => rpc.method === 'group_chat.send_message');
  assert.deepEqual(sent.params, { sessionId, content: 'Final answer', toolCallId: `turn:${agentThreadId}:1` });
  assert.equal(f.rpcs.at(-1).params.state, 'idle');
  assert.equal(ctx.options.get('session/event').global, true);
  await host.close(); assert.equal(ctx.toolDefinitions.size, 0); assert.equal(ctx.listeners.get('approval/request').length, 0);
});
test('resume success never creates a new session; permission errors never fall back to create', async t => {
  const { ctx } = await setup(t, { resume: true }); assert.equal(ctx.calls.create.length, 0);
  const f = await fixture(t); const deniedCtx = hostContext({ resumeError: Object.assign(new Error('access denied'), { code: 'EACCES' }) });
  const bridge = new BridgeClient(f.credentials); const host = new NiaTeamsHost(deniedCtx, bridge); t.after(() => host.close());
  await bridge.start(); f.send(message()); await until(() => deniedCtx.calls.resume.length === 1);
  assert.equal(deniedCtx.calls.create.length, 0); assert.equal(deniedCtx.calls.followup.length, 0);
  assert.equal(f.frames.filter(frame => frame.type === 'ack').length, 0);
});
test('explicit send_message suppresses auto-publishing final assistant recap; aborted turns and child output are not published', async t => {
  const { f, ctx, agent } = await setup(t);
  await event(ctx, 'turn/start', { turn: 2 });
  await event(ctx, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Working' }] } });
  const tool = ctx.toolDefinitions.get('nia_group_chat_send_message');
  await tool.definition.execute({ content: 'Published via tool' }, { agent, callId: 'progress:1', signal: new AbortController().signal });
  await event(ctx, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Recap that should stay private' }] } });
  await event(ctx, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.deepEqual(f.rpcs.filter(rpc => rpc.method === 'group_chat.send_message').map(rpc => rpc.params.content), ['Published via tool']);
  // Post-tool EMPTY_RESPONSE (e.g. Gemini silent stop after nia_group_chat_send_message) lands cleanly on idle without false error badge.
  await event(ctx, 'turn/start', { turn: 21 });
  await tool.definition.execute({ content: 'Already delivered via tool' }, { agent, callId: 'progress:2', signal: new AbortController().signal });
  await event(ctx, 'turn/end', { turn: 21, reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE', message: 'model returned no content' } } });
  assert.deepEqual(f.rpcs.filter(rpc => rpc.method === 'thread.activity').at(-1).params, { sessionId, state: 'idle' });
  // Genuine post-tool errors and EMPTY_RESPONSE when nothing was published still surface errorMessage.
  await event(ctx, 'turn/start', { turn: 22 });
  await tool.definition.execute({ content: 'Partial update before failure' }, { agent, callId: 'progress:3', signal: new AbortController().signal });
  await event(ctx, 'turn/end', { turn: 22, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'upstream timed out' } } });
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'thread.activity').at(-1).params.errorMessage, 'upstream timed out');
  await event(ctx, 'turn/start', { turn: 23 });
  await event(ctx, 'turn/end', { turn: 23, reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE', message: 'empty with nothing sent' } } });
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'thread.activity').at(-1).params.errorMessage, 'empty with nothing sent');
  await event(ctx, 'turn/start', { turn: 3 });
  await event(ctx, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'Interrupted' }] } });
  await event(ctx, 'turn/end', { turn: 3, reason: { kind: 'aborted' } });
  const child = ctx.addChild('child', agent); await event(ctx, 'turn/start', { turn: 1 }, child.id);
  await event(ctx, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Child private result' }] } }, child.id);
  await event(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, child.id);
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'group_chat.send_message').length, 3);
  const stranger = ctx.addChild('stranger');
  assert.equal(tool.config.when({ agent: stranger }), false);
  await assert.rejects(tool.definition.execute({ content: 'spoof' }, { agent: stranger }), /does not own/);
});
test('real RS256 approval allows once, tampered argument hash fails closed, descendants are owned and strangers delegate', async t => {
  const { f, ctx, host, agent } = await setup(t);
  assert.deepEqual(ctx.options.get('approval/request'), { global: true, prepend: true });
  const child = ctx.addChild('child', agent); const grandchild = ctx.addChild('grandchild', child);
  assert.ok(host.ownsAgent(grandchild));
  const req = { agent: grandchild, toolName: 'shell', callId: 'call-1', reason: 'Run tests' };
  const granted = ctx.emit('approval/request', req, () => assert.fail('must intercept'));
  const card = await cardAfter(f); assert.equal(card.params.cardId, `agent_bridge:${teamId}:${agentThreadId}:call-1`);
  assert.deepEqual(card.params.verifyArguments, { agentThreadId, toolName: 'shell', callId: 'call-1', reason: 'Run tests' });
  await f.confirm(card); assert.equal(await granted, 'allowed-once');
  const denied = ctx.emit('approval/request', { ...req, callId: 'call-2' }, () => assert.fail('must intercept'));
  const tampered = await cardAfter(f, 1); await f.confirm(tampered, { tamper: true }); assert.equal(await denied, 'rejected');
  const noToken = ctx.emit('approval/request', { ...req, callId: 'call-3' }, () => assert.fail('must intercept'));
  const unsigned = await cardAfter(f, 2);
  f.send({ type: 'card.action', protocolVersion: 1, deliveryId: 'unsigned', sessionId, groupChatId, agentThreadId, cardId: unsigned.params.cardId, decision: 'approved', clickedBy: { userId, name: 'Alex' } });
  assert.equal(await noToken, 'rejected');
  const stranger = ctx.addChild('stranger');
  assert.equal(await ctx.emit('approval/request', { ...req, agent: stranger }, async () => 'fallback'), 'fallback');
});
test('abort cancels TaskBar cards; dismissed card rejects; optional session preauthorization is scoped', async t => {
  const { f, ctx, agent } = await setup(t, undefined, { sessionAllowTools: ['read_file'] });
  assert.equal(await ctx.emit('approval/request', { agent, toolName: 'read_file' }), 'allowed-once');
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'card.upsert').length, 0);
  const abort = new AbortController();
  const result = ctx.emit('approval/request', { agent, toolName: 'shell', callId: 'abort', signal: abort.signal });
  const card = await cardAfter(f); abort.abort(); assert.equal(await result, 'cancelled');
  await until(() => f.rpcs.some(rpc => rpc.method === 'card.cancel' && rpc.params.cardId === card.params.cardId));
  const dismissed = ctx.emit('approval/request', { agent, toolName: 'shell', callId: 'dismiss' });
  await f.confirm(await cardAfter(f, 1), { decision: 'canceled' }); assert.equal(await dismissed, 'rejected');
});
test('ordinary questions consume next human reply without duplicate followup, parse multiple choices, and abort cleanly', async t => {
  const { f, ctx, agent } = await setup(t);
  const request = { agent, questions: [{ id: 'color', question: 'Choose colors', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: true }, { id: 'name', question: 'Project name?' }] };
  const answer = ctx.emit('user-questions/request', request);
  await until(() => f.rpcs.some(rpc => rpc.method === 'group_chat.send_message'));
  const prompt = f.rpcs.find(rpc => rpc.method === 'group_chat.send_message').params.content;
  assert.match(prompt, new RegExp(`<mention userId="${userId}" />`)); assert.match(prompt, /1\. Red/);
  f.send(message('Q1=1,2\nQ2=New project'));
  assert.deepEqual(await answer, { answers: [{ id: 'color', selected: ['Red', 'Blue'] }, { id: 'name', selected: [], custom: 'New project' }] });
  assert.equal(ctx.calls.followup.length, 1);
  const abort = new AbortController(); const cancelled = ctx.emit('user-questions/request', { ...request, signal: abort.signal });
  const rejection = assert.rejects(cancelled, error => error.name === 'UserQuestionError' && error.code === 'ASK_ABORTED');
  await until(() => f.rpcs.filter(rpc => rpc.method === 'group_chat.send_message').length === 2); abort.abort(); await rejection;
  f.send(message('Resume normal chat')); await until(() => ctx.calls.followup.length === 2);
});
test('approval-intent questions use signed cards, choose exact intent labels, and map dismissal to deny', async t => {
  const { f, ctx, agent } = await setup(t);
  const req = { agent, questions: [approvalQuestion] };
  const approved = ctx.emit('user-questions/request', req); const card = await cardAfter(f);
  assert.equal(card.params.verifyToolName, 'dsh.question_approval'); assert.deepEqual(card.params.verifyArguments, { agentThreadId, questionIds: ['perm'] });
  await f.confirm(card); assert.deepEqual(await approved, { answers: [{ id: 'perm', selected: ['Allow once'] }] });
  const canceled = ctx.emit('user-questions/request', req); await f.confirm(await cardAfter(f, 1), { decision: 'canceled' });
  assert.deepEqual(await canceled, { answers: [{ id: 'perm', selected: ['Deny'] }] });
  const tampered = ctx.emit('user-questions/request', req); await f.confirm(await cardAfter(f, 2), { tamper: true });
  assert.deepEqual(await tampered, { answers: [{ id: 'perm', selected: ['Deny'] }] });
});
test('thread cancellation stops Agent and pending questions; group removal disposes the owned root', async t => {
  const { f, ctx, host, agent } = await setup(t);
  const answer = ctx.emit('user-questions/request', { agent, questions: [{ id: 'q', question: 'Continue?' }] });
  const rejected = assert.rejects(answer, error => error.code === 'ASK_ABORTED');
  await until(() => f.rpcs.some(rpc => rpc.method === 'group_chat.send_message'));
  f.send({ type: 'thread.cancel', protocolVersion: 1, deliveryId: 'stop', sessionId, groupChatId, agentThreadId, reason: 'removed_from_group' });
  await rejected; await until(() => ctx.calls.disposed.includes(agentThreadId));
  assert.equal(ctx.calls.cancelled.length, 1); assert.equal(host.ownsAgent(agent), false);
});
test('question parser supports exact labels, numbered multi-question lines, custom input and rejects incomplete batches', () => {
  const questions = [{ id: 'a', options: [{ label: 'One' }, { label: 'Two' }] }, { id: 'b', options: [{ label: 'Yes' }] }];
  assert.deepEqual(parseQuestionReply(questions, '2\nYes'), { answers: [{ id: 'a', selected: ['Two'] }, { id: 'b', selected: ['Yes'] }] });
  assert.equal(parseQuestionReply(questions, '1'), undefined);
});

test('thread message while approval card is pending cancels the card on its original session and steers immediately', async t => {
  const { f, ctx, agent } = await setup(t);
  const pending = ctx.emit('approval/request', { agent, toolName: 'shell', callId: 'rotate' });
  const card = await cardAfter(f);
  const nextFrame = message('Why are you running this command?');
  nextFrame.sessionId = '456789abcdef0123456789ab';
  f.send(nextFrame);
  assert.equal(await pending, 'cancelled');
  await until(() => f.rpcs.some(rpc => rpc.method === 'card.cancel' && rpc.params.cardId === card.params.cardId && rpc.params.sessionId === sessionId));
  await until(() => ctx.calls.steer.length === 1);
  assert.match(ctx.calls.steer[0].message.content[0].text, /Why are you running this command\?/);
});
test('abort before card upsert response cancels again after upsert; already-aborted requests create no card', async t => {
  const { f, ctx, agent } = await setup(t);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await ctx.emit('approval/request', { agent, toolName: 'shell', signal: cancelled.signal }), 'cancelled');
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'card.upsert').length, 0);
  f.holdRpc.add('card.upsert'); const abort = new AbortController();
  const pending = ctx.emit('approval/request', { agent, toolName: 'shell', callId: 'slow-upsert', signal: abort.signal });
  const card = await cardAfter(f); abort.abort();
  await until(() => f.rpcs.some(rpc => rpc.method === 'card.cancel'));
  f.send({ type: 'rpc.response', protocolVersion: 1, requestId: card.requestId, ok: true, result: { cardId: card.params.cardId } });
  assert.equal(await pending, 'cancelled');
  assert.equal(f.rpcs.filter(rpc => rpc.method === 'card.cancel').length, 2);
});
test('a question answer is consumed once; a following message starts the next turn even while answer cleanup is in flight', async t => {
  const { f, ctx, agent } = await setup(t);
  const pending = ctx.emit('user-questions/request', { agent, questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'Yes' }] }] });
  await until(() => f.rpcs.some(rpc => rpc.method === 'group_chat.send_message'));
  f.send(message('1')); f.send(message('Next task'));
  assert.deepEqual(await pending, { answers: [{ id: 'q', selected: ['Yes'] }] });
  await until(() => ctx.calls.followup.length === 2);
  assert.match(ctx.calls.followup[1].message.content[0].text, /Next task/);
});
test('mixed permission and ordinary question batches fail closed instead of permitting text-only approval', async t => {
  const { ctx, agent } = await setup(t);
  await assert.rejects(ctx.emit('user-questions/request', { agent, questions: [approvalQuestion, { id: 'ordinary', question: 'What name?' }] }), /separately/);
});
test('plugin shutdown cancels pending approvals and disposes all its resources', async t => {
  const { f, ctx, host, agent } = await setup(t);
  const pending = ctx.emit('approval/request', { agent, toolName: 'shell', callId: 'shutdown' });
  await cardAfter(f); await host.close(); assert.equal(await pending, 'cancelled');
  assert.equal(ctx.toolDefinitions.size, 0); assert.deepEqual(ctx.calls.disposed, [agentThreadId]);
});
test('agent setup injects GroupChat @mention and Rich HTML CSS variable guidance into system-prompt/assemble without mutating host files', async t => {
  const { ctx, agent } = await setup(t);
  const setupFn = ctx.calls.create[0].setup;
  assert.equal(typeof setupFn, 'function');
  const scopedListeners = new Map();
  await setupFn({ on: (name, fn) => scopedListeners.set(name, fn) }, agent);
  const assemble = scopedListeners.get('system-prompt/assemble');
  assert.equal(typeof assemble, 'function');
  const assembled = await assemble({}, {}, async () => ({ sections: [{ name: 'base', text: 'Base prompt' }], variables: {} }));
  const groupChatSection = assembled.sections.find(section => section.name === 'nia-teams:group-chat');
  assert.ok(groupChatSection);
  assert.equal(groupChatSection.interpolate, false);
  assert.match(groupChatSection.text, /<mention userId="24-hex-member-id" \/>/);
  assert.match(groupChatSection.text, /var\(--bg-card\)/);
  assert.match(groupChatSection.text, /Rich HTML/);
});
