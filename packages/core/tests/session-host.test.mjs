import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHost, consumeSdkQuery, BridgeClient, resolveThreadPrompt, formatThreadMessage } from '../dist/index.js';
import { fixture, message, until, contract } from './helpers.mjs';

test('activity transport failures cannot turn a successful SDK result into a failed turn', async t => {
  const f = await fixture(t), errors = [], calls = [];
  let activityFailures = 2;
  const bridge = {
    getContract: () => contract,
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
  assert.deepEqual(calls.filter(c => (c.method === 'tool.call' && c.params.name === 'send_message')).map(c => c.params.arguments.content), []);
  assert.equal(errors.length, 2); assert.equal(closed, 1);
  // A later turn still runs after those errors.
  host.message(message('next'));
  await until(() => calls.filter(c => c.method === 'thread.activity' && c.params.state === 'idle').length === 2);
});

for (const [label, events, expected] of [
  ['runtime error', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model unavailable'] }], /model unavailable/],
  ['missing result', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }], /without a result/],
]) test(`SDK ${label} is surfaced and query is closed`, async () => {
  let closed = 0;
  await assert.rejects(consumeSdkQuery({ async *[Symbol.asyncIterator]() { yield* events; }, close() { closed++; } }, { signal: new AbortController().signal }), expected);
  assert.equal(closed, 1);
});


test('server reminder resumes the local session; only explicit send publishes and idle is delivery-scoped', async t => {
  const f = await fixture(t), contexts = [];
  const bridge = new BridgeClient(f.credentials);
  const host = new SessionHost(bridge, async context => {
    contexts.push(context);
    if (!context.resume) await context.session('local-session');
    else { await context.history(3, 0); await context.send('Explicit reply', 'send-1'); }
    // Runtime JS can still return an obsolete shape; core must never publish it.
    return { text: 'PRIVATE TERMINAL TEXT' };
  }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test' });
  t.after(async () => { await host.close(); bridge.close(); });
  await host.start(); await bridge.start();
  const first = message(); f.send(first);
  const idle = () => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle');
  await until(() => idle().length === 1);
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length, 0);
  assert.equal(idle()[0].params.deliveryId, first.deliveryId);
  const reminder = { ...message(), prompt: '<system-reminder>Use send_message to reply.</system-reminder>' };
  f.send(reminder); await until(() => idle().length === 2);
  assert.equal(contexts[1].prompt, reminder.prompt); assert.equal(contexts[1].resume, 'local-session');
  assert.equal(contexts[1].deliveryId, reminder.deliveryId);
  assert.deepEqual(contexts[1].tools, contract.tools); assert.equal(contexts[1].systemPrompt, contract.systemPrompt);
  assert.equal(idle()[1].params.deliveryId, reminder.deliveryId);
  assert.deepEqual(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).map(r => r.params.arguments.content), ['Explicit reply']);
  assert.deepEqual(resolveThreadPrompt({ ...first, prompt: '' }), formatThreadMessage(first));
  assert.equal(resolveThreadPrompt({ ...first, prompt: '  ' }), '  ');
});

test('turn errors report idle with deliveryId', async t => {
  const f = await fixture(t), errors = [];
  const bridge = new BridgeClient(f.credentials);
  const host = new SessionHost(bridge, async () => { throw new Error('runtime failure'); }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  t.after(async () => { await host.close(); bridge.close(); });
  await host.start(); await bridge.start(); const frame = message(); f.send(frame);
  await until(() => f.rpcs.some(r => r.params.errorMessage));
  const error = f.rpcs.find(r => r.params.errorMessage);
  assert.equal(error.params.deliveryId, frame.deliveryId); assert.equal(error.params.state, 'idle');
  assert.equal(errors[0].message, 'runtime failure');
});

test('missing ready contract fails the turn before calling a runtime', async t => {
  const f = await fixture(t), calls = [], errors = [];
  const bridge = {
    credentials: f.credentials, getContract: () => undefined,
    onReady: () => () => {}, onThreadMessage: () => () => {}, onThreadCancel: () => () => {}, onCardAction: () => () => {},
    rpc: async (method, params) => { calls.push({ method, params }); return {}; },
  };
  const host = new SessionHost(bridge, async () => assert.fail('must not run'), { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  await host.start(); t.after(() => host.close()); const frame = message(); host.message(frame);
  await until(() => calls.some(c => c.params.state === 'idle'));
  assert.equal(errors[0].message, 'Bridge contract is missing');
  assert.equal(calls.at(-1).params.deliveryId, frame.deliveryId);
});

test('arbitrary handshake tools use tool.call and preserve JSON-string content and isError', async t => {
  const f = await fixture(t), errors = [], results = [];
  f.readyOverrides = { tools: [...contract.tools, { name: 'future_tool', description: 'Future', inputSchema: { type: 'object' }, deferLoading: true }] };
  f.handleRpc = (frame, ws) => {
    if (frame.method !== 'tool.call' || frame.params.name !== 'future_tool') return false;
    ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: frame.requestId, ok: true, result: { content: '{"card":"value"}', isError: true } })); return true;
  };
  const bridge = new BridgeClient(f.credentials);
  const host = new SessionHost(bridge, async ctx => {
    results.push(await ctx.callTool('future_tool', { value: 7 }, 'future-call'));
    await assert.rejects(ctx.callTool('unknown', {}), /Unknown/);
    await assert.rejects(ctx.callTool('send_message', { content: ' ' }), /nonempty/);
    results.push(await ctx.callTool('send_message', { content: 'Visible' }, 'send-call'));
  }, { configDir: f.dir, runtime: 'test', approvalTool: 'test', onError: e => errors.push(e) });
  t.after(async () => { await host.close(); bridge.close(); }); await host.start(); await bridge.start(); f.send(message());
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  assert.deepEqual(results, [{ content: '{"card":"value"}', isError: true }, { content: '消息已发布到聊天' }]);
  assert.deepEqual(f.rpcs.find(r => r.params.name === 'future_tool').params.arguments, { value: 7 });
  assert.ok(f.rpcs.findIndex(r => r.params.name === 'send_message') < f.rpcs.findIndex(r => r.params.state === 'idle'));
  assert.deepEqual(errors, []);
});
