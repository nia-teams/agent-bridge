import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationQueue } from '../dist/publications.js';
import { sessionId, until } from './helpers.mjs';
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
