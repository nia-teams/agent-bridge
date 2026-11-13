import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient } from '../dist/index.js';
import { fixture, message, until, sessionId } from './helpers.mjs';

test('challenge → signed lease → hello/ready, heartbeat, concurrent dedup, and reconnect replay', async t => {
  const f = await fixture(t); const errors = [];
  const bridge = new BridgeClient(f.credentials, { heartbeatMs: 15, reconnectBaseMs: 10, onError: error => errors.push(error) });
  t.after(() => bridge.close());
  let count = 0; let accept;
  bridge.onThreadMessage(async () => { count++; await new Promise(resolve => { accept = resolve; }); });
  await bridge.start();
  assert.deepEqual(await bridge.rpc('group_chat.history', { sessionId }), { text: 'Earlier chat' });
  const frame = message(); f.send(frame); f.send(frame);
  await until(() => count === 1); assert.equal(f.frames.filter(frame => frame.type === 'ack').length, 0);
  accept();
  await until(() => f.frames.filter(frame => frame.type === 'ack').length === 2);
  await until(() => f.frames.some(frame => frame.type === 'heartbeat'));
  f.holdRpc.add('group_chat.history');
  const failed = assert.rejects(bridge.rpc('group_chat.history', { sessionId }), /disconnected/);
  await until(() => f.rpcs.filter(rpc => rpc.method === 'group_chat.history').length === 2);
  const old = f.socket; f.socket.terminate(); await failed;
  await until(() => f.socket !== old, 'new handshake');
  f.send(frame);
  await until(() => f.frames.filter(frame => frame.type === 'ack').length === 3);
  assert.equal(count, 1); assert.equal(f.connections, 2);
  assert.equal(f.requests.filter(request => request.path.endsWith('/challenge')).length, 2);
  bridge.close(); await assert.rejects(bridge.start(), /closed/);
});
test('failed acceptance is retried and RPC timeout/abort clean up', async t => {
  const f = await fixture(t); const bridge = new BridgeClient(f.credentials, { rpcTimeoutMs: 40 });
  t.after(() => bridge.close()); let attempts = 0;
  bridge.onThreadMessage(() => { if (++attempts === 1) throw new Error('transient'); });
  await bridge.start(); const frame = message(); f.send(frame);
  await until(() => attempts === 1); assert.equal(f.frames.filter(frame => frame.type === 'ack').length, 0);
  f.send(frame); await until(() => f.frames.some(frame => frame.type === 'ack')); assert.equal(attempts, 2);
  f.holdRpc.add('group_chat.history');
  await assert.rejects(bridge.rpc('group_chat.history', { sessionId }), /timeout/);
  const abort = new AbortController();
  const pending = bridge.rpc('group_chat.history', { sessionId }, abort.signal); abort.abort();
  await assert.rejects(pending, /aborted/);
});
test('rotated keys fail before lease and superseded host stops reconnecting', async t => {
  const f = await fixture(t); const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10 });
  t.after(() => bridge.close()); f.keyGeneration = 2;
  await assert.rejects(bridge.start(), /generation/); bridge.close();
  assert.equal(f.requests.filter(request => request.path.endsWith('/lease')).length, 0);
  f.keyGeneration = 1;
  const replacement = new BridgeClient(f.credentials, { reconnectBaseMs: 10 }); t.after(() => replacement.close());
  await replacement.start(); f.socket.close(4409, 'superseded');
  await until(() => f.sockets.size === 0);
  await assert.rejects(replacement.start(), /closed/);
  assert.equal(f.connections, 1);
});

test('structured RPC errors preserve code and retryability', async t => {
  const f = await fixture(t); const bridge = new BridgeClient(f.credentials); t.after(() => bridge.close());
  await bridge.start();
  f.handleRpc = (rpc, ws) => { ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 1, requestId: rpc.requestId, ok: false, error: { code: 'invalid_request', message: 'Invalid parameters', retryable: false } })); return true; };
  await assert.rejects(bridge.rpc('group_chat.history', { sessionId }), error => error.code === 'invalid_request' && error.retryable === false && error.message === 'Invalid parameters');
});

test('RPC waits through reconnect handshake instead of failing not-ready', async t => {
  const f = await fixture(t);
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 5, rpcTimeoutMs: 1000 });
  t.after(() => bridge.close());
  await bridge.start();
  const old = f.socket; f.holdReady = true; old.terminate();
  await until(() => f.socket !== old && f.waitingReady);
  let settled = false;
  const rpc = bridge.rpc('group_chat.history', { sessionId }).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(f.rpcs.length, 0);
  f.waitingReady();
  assert.deepEqual(await rpc, { text: 'Earlier chat' });
  assert.equal(f.rpcs.length, 1);
});

test('ready waits are bounded, abortable, released on close, and never send before ready', async t => {
  const f = await fixture(t); f.holdReady = true;
  const bridge = new BridgeClient(f.credentials, { rpcTimeoutMs: 30 });
  t.after(() => bridge.close());
  const start = bridge.start(); void start.catch(() => {});
  await until(() => f.waitingReady);
  await assert.rejects(bridge.rpc('group_chat.history', { sessionId }), /ready timeout/);
  const controller = new AbortController();
  const rpc = bridge.rpc('group_chat.history', { sessionId }, controller.signal);
  controller.abort(); await assert.rejects(rpc, /aborted/);
  const closed = assert.rejects(bridge.rpc('group_chat.history', { sessionId }), /closed/);
  bridge.close(); await closed; await assert.rejects(start, /before ready/);
  assert.equal(await bridge.whenClosed(), undefined);
  assert.equal(f.rpcs.length, 0);
});

test('supersession has an explicit terminal failure and does not reconnect', async t => {
  const f = await fixture(t); const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 5 });
  t.after(() => bridge.close()); await bridge.start();
  f.socket.close(4409, 'replacement host');
  const error = await bridge.whenClosed();
  assert.equal(error.code, 'host_superseded');
  assert.equal(error.retryable, false);
  assert.match(error.message, /4409.*replacement host/);
  await assert.rejects(bridge.rpc('group_chat.history', { sessionId }), /superseded/);
  assert.equal(f.connections, 1);
});

test('every authenticated reconnect reports installed client branding for already-paired hosts', async t => {
  const f = await fixture(t);
  const metadata = { clientName: 'Future product #99', avatar: 'data:image/png;base64,aW1hZ2U=' };
  const bridge = new BridgeClient(f.credentials, { ...metadata, reconnectBaseMs: 5 });
  t.after(() => bridge.close());
  await bridge.start();
  const old = f.socket; old.terminate();
  await until(() => f.connections === 2);
  const requests = f.requests.filter(r => r.path.endsWith('/lease'));
  assert.equal(requests.length, 2);
  for (const { body } of requests) {
    assert.equal(body.clientName, metadata.clientName);
    assert.equal(body.avatar, metadata.avatar);
    assert.ok(body.signature);
  }
});
