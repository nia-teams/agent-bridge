import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHost, consumeSdkQuery } from '../dist/index.js';
import { fixture, message, until } from './helpers.mjs';

test('activity transport failures cannot turn a successful SDK result into a failed turn', async t => {
  const f = await fixture(t), errors = [], calls = [];
  let activityFailures = 2;
  const bridge = {
    credentials: f.credentials,
    onReady: () => () => {}, onThreadMessage: () => () => {}, onThreadCancel: () => () => {}, onCardAction: () => () => {},
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'thread.activity' && activityFailures-- > 0) throw new Error('Agent Bridge is not ready');
      return {};
    },
  };
  let closed = 0;
  const host = new SessionHost(bridge, context => consumeSdkQuery({
    async *[Symbol.asyncIterator]() {
      yield { type: 'tool_progress', tool_name: 'Bash' };
      yield { type: 'result', subtype: 'success', result: 'Completed reply' };
    }, close() { closed++; },
  }, context), { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  await host.start(); t.after(() => host.close()); host.message(message());
  await until(() => calls.some(c => c.method === 'thread.activity' && c.params.state === 'idle'));
  assert.deepEqual(calls.filter(c => c.method === 'group_chat.send_message').map(c => c.params.content), ['Completed reply']);
  assert.equal(errors.length, 2); assert.equal(closed, 1);
  // A later turn still runs after those errors.
  host.message(message('next'));
  await until(() => calls.filter(c => c.method === 'group_chat.send_message').length === 2);
});

for (const [label, events, expected] of [
  ['runtime error', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model unavailable'] }], /model unavailable/],
  ['missing result', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }], /without a result/],
]) test(`SDK ${label} is surfaced and query is closed`, async () => {
  let closed = 0;
  await assert.rejects(consumeSdkQuery({ async *[Symbol.asyncIterator]() { yield* events; }, close() { closed++; } }, { signal: new AbortController().signal }), expected);
  assert.equal(closed, 1);
});
