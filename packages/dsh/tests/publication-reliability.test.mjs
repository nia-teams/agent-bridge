import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, NiaTeamsHost } from '../dist/index.js';
import { PublicationQueue } from '../dist/publications.js';
import { fixture, hostContext, message, until, agentThreadId, sessionId } from './helpers.mjs';

async function setup(t) {
  const f = await fixture(t); const ctx = hostContext();
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10 });
  const host = new NiaTeamsHost(ctx, bridge);
  t.after(() => host.close());
  await bridge.start(); const frame = message(); f.send(frame);
  await until(() => f.frames.some(received => received.type === 'ack' && received.deliveryId === frame.deliveryId));
  return { f, ctx, bridge, host, agent: ctx.agents.get(agentThreadId) };
}
const event = (ctx, type, data) => ctx.emit('session/event', { id: agentThreadId }, { type, data });
async function prepareTurn(ctx, turn, text) {
  await event(ctx, 'turn/start', { turn });
  await event(ctx, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
}
async function disconnectAndHoldReady(f) {
  f.holdReady = true; f.waitingReady = undefined; f.socket.terminate();
  await until(() => f.waitingReady, 'new connection waiting for authenticated ready');
}
function releaseReady(f) { f.holdReady = false; const ready = f.waitingReady; f.waitingReady = undefined; ready(); }
const messages = f => f.rpcs.filter(rpc => rpc.method === 'group_chat.send_message');
const idle = f => f.rpcs.filter(rpc => rpc.method === 'thread.activity' && rpc.params.state === 'idle');

test('LOST FINAL RESULT: outage before turn/end queues answers in order, then ready flushes exact IDs and final idle', async t => {
  const { f, ctx } = await setup(t);
  await prepareTurn(ctx, 1, 'LOST FINAL RESULT');
  await disconnectAndHoldReady(f);
  await event(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await prepareTurn(ctx, 2, 'SECOND FINAL RESULT');
  await event(ctx, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'Example turn error' } } });
  assert.equal(messages(f).length, 0);
  releaseReady(f);
  await until(() => messages(f).length === 2 && idle(f).length > 0, 'replayed final publications and idle');
  assert.deepEqual(messages(f).map(rpc => rpc.params), [
    { sessionId, toolCallId: `turn:${agentThreadId}:1`, content: 'LOST FINAL RESULT' },
    { sessionId, toolCallId: `turn:${agentThreadId}:2`, content: 'SECOND FINAL RESULT' },
  ]);
  assert.equal(idle(f).at(-1).params.errorMessage, 'Example turn error');
  assert.equal(ctx.calls.followup.length, 1, 'already-acked inbound message is not needed for recovery');
});

test('outage during final send reuses toolCallId after an accepted send with a lost RPC response', async t => {
  const { f, ctx } = await setup(t);
  const published = new Map(); const attempts = [];
  f.holdReady = true;
  f.handleRpc = (rpc, ws) => {
    if (rpc.method !== 'group_chat.send_message') return false;
    attempts.push(rpc.params.toolCallId);
    // Model the server idempotency boundary: first request commits, but its acknowledgment is lost.
    if (!published.has(rpc.params.toolCallId)) published.set(rpc.params.toolCallId, rpc.params.content);
    if (attempts.length === 1) { ws.terminate(); return true; }
    return false;
  };
  await prepareTurn(ctx, 7, 'LOST FINAL RESULT');
  await event(ctx, 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await until(() => f.waitingReady);
  assert.equal(attempts.length, 1);
  releaseReady(f);
  await until(() => attempts.length === 2 && idle(f).length === 1);
  assert.deepEqual(attempts, [`turn:${agentThreadId}:7`, `turn:${agentThreadId}:7`]);
  assert.deepEqual([...published.values()], ['LOST FINAL RESULT']);
});

test('non-retryable send error drops the item, logs failure, and does not retry it on later ready', async t => {
  const { f, ctx } = await setup(t);
  f.handleRpc = (rpc, ws) => {
    if (rpc.method !== 'group_chat.send_message') return false;
    ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 1, requestId: rpc.requestId, ok: false,
      error: { code: 'session_not_found', message: 'Session no longer exists', retryable: false } }));
    return true;
  };
  await prepareTurn(ctx, 1, 'Terminal failure');
  await event(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await until(() => ctx.calls.warnings.some(warning => warning.includes('Session no longer exists')));
  await disconnectAndHoldReady(f);
  f.handleRpc = undefined;
  releaseReady(f);
  await prepareTurn(ctx, 2, 'Next answer');
  await event(ctx, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  await until(() => messages(f).length === 2 && idle(f).length > 0);
  assert.deepEqual(messages(f).map(rpc => rpc.params.toolCallId), [`turn:${agentThreadId}:1`, `turn:${agentThreadId}:2`]);
});

test('ordinary question requested while reconnecting publishes on ready and consumes the answer without followup', async t => {
  const { f, ctx, agent } = await setup(t);
  await disconnectAndHoldReady(f);
  const answer = ctx.emit('user-questions/request', { agent, wait: { callId: 'offline-question' },
    questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
  let settled = false; void answer.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false); assert.equal(messages(f).length, 0);
  releaseReady(f);
  await until(() => messages(f).length === 1 && f.rpcs.some(rpc => rpc.method === 'thread.activity' && rpc.params.state === 'waiting'));
  assert.equal(messages(f)[0].params.toolCallId, 'offline-question');
  f.send(message('1'));
  assert.deepEqual(await answer, { answers: [{ id: 'q', selected: ['Yes'] }] });
  assert.equal(ctx.calls.followup.length, 1);
});

test('aborting a question during an outage removes its queued prompt before reconnect', async t => {
  const { f, ctx, bridge, agent } = await setup(t);
  await disconnectAndHoldReady(f);
  const abort = new AbortController();
  const answer = ctx.emit('user-questions/request', { agent, signal: abort.signal, questions: [{ id: 'q', question: 'Continue?' }] });
  const rejected = assert.rejects(answer, error => error.name === 'UserQuestionError' && error.code === 'ASK_ABORTED');
  abort.abort(); await rejected;
  releaseReady(f);
  await until(() => !f.holdReady && f.frames.filter(frame => frame.type === 'hello').length === 2);
  await bridge.start(); await bridge.rpc('group_chat.history', { sessionId });
  assert.equal(messages(f).length, 0);
});

function stubBridge() {
  const handlers = new Set();
  return { handlers, calls: [], online: false,
    onReady(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async rpc(method, params) { this.calls.push({ method, params }); if (!this.online) throw new Error('temporarily disconnected'); return {}; },
    ready() { this.online = true; for (const handler of handlers) handler(); },
  };
}
function publication(toolCallId, extra = {}) {
  return { niaSessionId: sessionId, toolCallId, content: toolCallId, activityAfter: { state: 'idle' }, shouldSyncActivity: () => true, ...extra };
}

test('bounded queue rejects overflow without evicting accepted items and disposal releases entries/listeners', async () => {
  const bridge = stubBridge(); const queue = new PublicationQueue(bridge, { maxItems: 1, retryMs: 60_000 });
  const first = queue.enqueue(publication('first')); await queue.flush();
  assert.throws(() => queue.enqueue(publication('second')), /queue is full/);
  bridge.ready(); await first;
  const second = queue.enqueue(publication('second')); await second;
  assert.deepEqual(bridge.calls.filter(call => call.method === 'group_chat.send_message').slice(-2).map(call => call.params.toolCallId), ['first', 'second']);
  bridge.online = false;
  const pending = queue.enqueue(publication('pending')); const rejected = assert.rejects(pending, /closed/);
  queue.close(); await rejected;
  assert.equal(bridge.handlers.size, 0); assert.throws(() => queue.enqueue(publication('closed')), /closed/);
});

test('activity-only retry does not resend an acknowledged message, and newer turns suppress stale idle', async () => {
  const bridge = stubBridge(); bridge.online = true; let firstActivity = true; let current = true;
  const original = bridge.rpc;
  bridge.rpc = async (method, params) => {
    if (method === 'thread.activity' && firstActivity) { firstActivity = false; bridge.calls.push({ method, params }); throw new Error('lost activity response'); }
    return original.call(bridge, method, params);
  };
  const queue = new PublicationQueue(bridge, { retryMs: 60_000 });
  try {
    const pending = queue.enqueue(publication('sent', { shouldSyncActivity: () => current }));
    await queue.flush(); current = false; bridge.ready(); await pending;
    assert.equal(bridge.calls.filter(call => call.method === 'group_chat.send_message').length, 1);
    assert.equal(bridge.calls.filter(call => call.method === 'thread.activity').length, 1);
  } finally { queue.close(); }
});

test('retryable RPC errors retry even without a socket reconnect', async () => {
  const bridge = stubBridge(); bridge.online = true; let failures = 1;
  const original = bridge.rpc;
  bridge.rpc = async (method, params) => { if (method === 'group_chat.send_message' && failures-- > 0) throw Object.assign(new Error('busy'), { retryable: true }); return original.call(bridge, method, params); };
  const queue = new PublicationQueue(bridge, { retryMs: 5 });
  try { await queue.enqueue(publication('retryable')); assert.equal(failures, -1); }
  finally { queue.close(); }
});

test('a ready event racing an in-flight RPC failure cannot strand the publication', async () => {
  const bridge = stubBridge(); let fail; let attempts = 0;
  bridge.rpc = async method => {
    if (method === 'group_chat.send_message' && ++attempts === 1) return await new Promise((_, reject) => { fail = reject; });
    return {};
  };
  const queue = new PublicationQueue(bridge, { retryMs: 60_000 });
  try {
    const pending = queue.enqueue(publication('ready-race'));
    bridge.ready(); fail(new Error('old socket closed'));
    await until(() => attempts === 2, 'ready-triggered retry instead of waiting for timer');
    await pending;
  } finally { queue.close(); }
});

test('queue enforces aggregate byte and frame bounds before admission without dropping existing work', async () => {
  const bridge = stubBridge(); const queue = new PublicationQueue(bridge, { maxBytes: 512, retryMs: 60_000 });
  try {
    const pending = queue.enqueue(publication('kept'));
    assert.throws(() => queue.enqueue(publication('too-many-bytes', { content: 'x'.repeat(512) })), /queue is full/);
    assert.throws(() => queue.enqueue(publication('oversize', { content: 'x'.repeat(512 * 1024) })), error => error.retryable === false);
    bridge.ready(); await pending;
    assert.equal(bridge.calls.filter(call => call.method === 'group_chat.send_message' && call.params.toolCallId !== 'kept').length, 0);
  } finally { queue.close(); }
});

test('a question answered after server acceptance but before its send acknowledgment is not re-posted', async t => {
  const { f, ctx, bridge, agent } = await setup(t);
  f.holdRpc.add('group_chat.send_message');
  const answer = ctx.emit('user-questions/request', { agent, wait: { callId: 'early-answer' },
    questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
  await until(() => messages(f).length === 1);
  f.send(message('1'));
  assert.deepEqual(await answer, { answers: [{ id: 'q', selected: ['Yes'] }] });
  await disconnectAndHoldReady(f); f.holdRpc.clear(); releaseReady(f);
  await bridge.start(); await bridge.rpc('group_chat.history', { sessionId });
  assert.equal(messages(f).length, 1);
});
