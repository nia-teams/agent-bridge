import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLease } from '../dist/index.js';

function bridge() {
  const calls = [], ready = new Set();
  return { calls, ready, onReady(fn) { ready.add(fn); return () => ready.delete(fn); }, async rpc(method, params, signal) { calls.push({ method, params, signal }); return {}; } };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('one timer only while active; record avoids duplicate reports; reconnect restores current labels', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const b = bridge(), lease = new ActivityLease(b, { intervalMs: 40 });
  t.after(() => lease.close());
  await lease.report('a', 's1', 'executing', { label: 'Thinking' });
  lease.record('b', 's2', { state: 'waiting', label: '等待回答' });
  assert.equal(b.calls.length, 1);
  t.mock.timers.tick(40); await settle();
  assert.equal(b.calls.length, 3);
  const revision = lease.record('a', 's1', { state: 'waiting', label: '等待确认' });
  assert.equal(lease.isCurrent('a', revision), true);
  for (const ready of b.ready) ready();
  await settle();
  assert.deepEqual(b.calls.slice(-2).map(c => c.params), [
    { sessionId: 's2', state: 'waiting', label: '等待回答' },
    { sessionId: 's1', state: 'waiting', label: '等待确认' },
  ]);
  lease.clear('a'); lease.clear('b');
  assert.equal(lease.isCurrent('a', revision), false);
  const count = b.calls.length;
  t.mock.timers.tick(400); for (const ready of b.ready) ready(); await settle();
  assert.equal(b.calls.length, count);
  lease.close(); assert.equal(b.ready.size, 0);
});

test('revision changes and clear abort in-flight renewal before idle; abort removes entries synchronously', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const b = bridge();
  b.rpc = (method, params, signal) => new Promise((resolve, reject) => {
    b.calls.push({ params, signal });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const lease = new ActivityLease(b, { intervalMs: 40 }); t.after(() => lease.close());
  const stop = new AbortController();
  lease.record('a', 's1', { state: 'executing' }, stop.signal);
  t.mock.timers.tick(40); assert.equal(b.calls.length, 1);
  t.mock.timers.tick(40); assert.equal(b.calls.length, 1, 'no overlapping renewal');
  lease.record('a', 's1', { state: 'waiting' }, stop.signal);
  assert.equal(b.calls[0].signal.aborted, true);
  for (const ready of b.ready) ready(); assert.equal(b.calls[1].params.state, 'waiting');
  stop.abort(); assert.equal(b.calls[1].signal.aborted, true);
  t.mock.timers.tick(400); for (const ready of b.ready) ready(); await settle();
  assert.equal(b.calls.length, 2);
});

test('RPC errors and throwing error callbacks are best effort; close rejects future records', async () => {
  const b = bridge(), errors = [];
  b.rpc = async () => { throw new Error('offline'); };
  const lease = new ActivityLease(b, { onError(error) { errors.push(error); throw error; } });
  await lease.report('a', 's1', 'executing');
  assert.equal(errors[0].message, 'offline');
  lease.close(); lease.record('a', 's1', { state: 'waiting' });
  assert.equal(b.ready.size, 0);
});
