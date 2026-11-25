import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { SessionHost, RuntimeMissingResultError, consumeSdkQuery, BridgeClient, resolveThreadPrompt, formatThreadMessage } from '../dist/index.js';
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

for (const outcome of ['complete', 'cancel']) test(`active SDK executing and question leases renew, reconnect, and stop on ${outcome}`, async t => {
  const f = await fixture(t);
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10 });
  let context, release;
  const hold = new Promise(resolve => { release = resolve; });
  const host = new SessionHost(bridge, async ctx => {
    context = ctx;
    await hold;
    if (!ctx.signal.aborted) await ctx.permission('AskUserQuestion', { questions: [{ question: 'Continue?' }] });
  }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', activityRefreshMs: 40 });
  t.after(async () => { release(); await host.close(); bridge.close(); });
  await host.start(); await bridge.start();
  const frame = message(); host.message(frame);
  const activities = state => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === state);
  await until(() => context && activities('executing').length >= 3);
  let connections = f.connections;
  f.socket.terminate();
  await until(() => f.connections > connections);
  await until(() => activities('executing').length >= 4);
  release();
  await until(() => activities('waiting').filter(r => r.params.label === '等待回答').length >= 3);
  connections = f.connections;
  f.socket.terminate();
  await until(() => f.connections > connections);
  await until(() => activities('waiting').length >= 4);
  if (outcome === 'cancel') host.cancel({ ...frame, type: 'thread.cancel', reason: 'user_aborted' });
  else host.message({ ...message('answer'), invokedBy: frame.invokedBy });
  await until(() => context.signal.aborted);
  // Cancellation uses best-effort idle; successful completion uses the queue.
  await new Promise(resolve => setTimeout(resolve, 80));
  const count = f.rpcs.filter(r => r.method === 'thread.activity').length;
  f.socket.terminate();
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(f.rpcs.filter(r => r.method === 'thread.activity').length, count);
  if (outcome === 'complete') assert.equal(activities('idle').at(-1).params.deliveryId, frame.deliveryId);
});

test('parallel SDK progress supersedes a pending send activity revision without interrupting renewal', async t => {
  const f = await fixture(t), bridge = new BridgeClient(f.credentials);
  let context, release;
  const hold = new Promise(resolve => { release = resolve; });
  const host = new SessionHost(bridge, async ctx => { context = ctx; await hold; }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', activityRefreshMs: 40 });
  t.after(async () => { release(); await host.close(); bridge.close(); });
  await host.start(); await bridge.start(); host.message(message());
  await until(() => context);
  f.holdRpc.add('tool.call'); const sending = context.send('Progress', 'held-send');
  await until(() => f.rpcs.some(r => r.params.name === 'send_message'));
  const held = f.rpcs.find(r => r.params.name === 'send_message');
  await context.activity('executing', 'Running newer command…');
  const offset = f.rpcs.length;
  f.socket.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: held.requestId, ok: true, result: { published: true } }));
  await sending;
  await until(() => f.rpcs.slice(offset).some(r => r.method === 'thread.activity'));
  assert.ok(f.rpcs.slice(offset).filter(r => r.method === 'thread.activity').every(r => r.params.label === 'Running newer command…'));
  release(); await until(() => context.signal.aborted);
});

test('thread.cancel sends idle with an independent non-aborted signal', async t => {
  const f = await fixture(t), bridge = new BridgeClient(f.credentials), errors = [];
  let context;
  const host = new SessionHost(bridge, async c => {
    context = c;
    await new Promise(resolve => c.signal.addEventListener('abort', resolve, { once: true }));
  }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  t.after(async () => { await host.close(); bridge.close(); });
  await host.start(); await bridge.start();
  const frame = message(); f.send(frame);
  await until(() => context);
  f.send({ ...frame, type: 'thread.cancel', deliveryId: 'cancel-delivery', reason: 'user_aborted' });
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  assert.equal(context.signal.aborted, true);
  const idle = f.rpcs.find(r => r.params.state === 'idle');
  assert.equal(idle.params.deliveryId, frame.deliveryId);
  assert.deepEqual(errors, []);
});

test('runtime failure during 1001 reconnect queues error idle behind pending send_message', async t => {
  const f = await fixture(t), bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10, rpcTimeoutMs: 10000 });
  const errors = []; let fail, sending;
  const failure = new Promise(resolve => { fail = resolve; });
  f.handleRpc = frame => frame.method === 'tool.call' && frame.params.name === 'send_message';
  const host = new SessionHost(bridge, async c => {
    sending = c.send('reply before failure');
    void sending.catch(() => {});
    await failure; throw new Error('runtime disconnected');
  }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  t.after(async () => { await host.close(); bridge.close(); });
  await host.start(); await bridge.start();
  const frame = message(); host.message(frame);
  await until(() => f.rpcs.some(r => r.params.name === 'send_message'));
  const first = f.rpcs.find(r => r.params.name === 'send_message');
  f.holdReady = true; f.socket.close(1001, 'transient disconnect');
  await until(() => !bridge.isReady());
  fail(); await until(() => errors.some(e => e.message === 'runtime disconnected'));
  await until(() => f.waitingReady);
  // Exceed the old one-shot idle's five-second signal deadline.
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.equal(f.rpcs.filter(r => r.params.state === 'idle').length, 0);
  f.handleRpc = undefined;
  const offset = f.rpcs.length; f.waitingReady();
  await until(() => f.rpcs.some(r => r.params.state === 'idle'));
  await sending;
  const delivered = f.rpcs.slice(offset);
  assert.deepEqual(delivered.map(r => r.method === 'tool.call' ? r.params.name : r.params.state), ['send_message', 'idle']);
  assert.equal(delivered[0].params.toolCallId, first.params.toolCallId);
  assert.deepEqual(delivered[1].params, { sessionId: frame.sessionId, state: 'idle', deliveryId: frame.deliveryId, errorMessage: 'runtime disconnected' });
  assert.deepEqual(errors.map(e => e.message), ['runtime disconnected']);
});

for (const cancelAfterReady of [false, true]) test(`cancel during queued error idle still delivers cleanup idle (reconnected=${cancelAfterReady})`, async t => {
  const f = await fixture(t), bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 5 });
  const errors = []; let context, fail;
  const failure = new Promise(resolve => { fail = resolve; });
  const host = new SessionHost(bridge, async c => {
    context = c; await failure; throw new Error('runtime failed before cancellation');
  }, { configDir: f.dir, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
  t.after(async () => { await host.close(); bridge.close(); });
  await host.start(); await bridge.start();
  const frame = message(); host.message(frame); await until(() => context);
  f.holdReady = true; f.socket.close(1001, 'transient disconnect');
  await until(() => !bridge.isReady()); await until(() => f.waitingReady);
  fail(); await until(() => errors.length === 1);
  assert.equal(context.signal.aborted, false);
  if (cancelAfterReady) {
    // Leave error-idle's RPC pending after reconnect so cancellation races its acknowledgment.
    f.holdRpc.add('thread.activity'); f.waitingReady();
    await until(() => f.rpcs.some(r => r.params.errorMessage));
    f.holdRpc.delete('thread.activity');
  }
  const offset = f.rpcs.length;
  host.cancel({ ...frame, type: 'thread.cancel', reason: 'user_aborted' });
  assert.equal(context.signal.aborted, true);
  if (!cancelAfterReady) f.waitingReady();
  await until(() => f.rpcs.slice(offset).some(r => r.params.state === 'idle'));
  const idle = f.rpcs.slice(offset).find(r => r.params.state === 'idle');
  assert.deepEqual(idle.params, { sessionId: frame.sessionId, state: 'idle', deliveryId: frame.deliveryId });
  await host.close();
  assert.deepEqual(errors.map(e => e.message), ['runtime failed before cancellation']);
});

for (const scenario of ['changed cwd', 'same cwd', 'stale legacy', 'fresh retry fails', 'OIDC auth', 'after send', 'after tool', 'after SDK tool']) {
  test(`cwd-aware resume: ${scenario}`, async t => {
    const f = await fixture(t), errors = [], attempts = [];
    const frame = message();
    const cwd = join(f.dir, 'current');
    const entry = { sessionId: 'saved', groupChatId: frame.groupChatId, updatedAt: 'old' };
    if (scenario === 'changed cwd') entry.cwd = join(f.dir, 'old');
    if (scenario === 'same cwd') entry.cwd = (process.platform === 'win32' ? cwd.toUpperCase() : cwd) + '/subdir/..';
    const path = join(f.dir, 'threads.json');
    await writeFile(path, JSON.stringify({ [frame.agentThreadId]: entry }), { mode: 0o600 });
    const saved = async () => JSON.parse(await readFile(path, 'utf8'))[frame.agentThreadId];
    const bridge = new BridgeClient(f.credentials);
    const host = new SessionHost(bridge, async context => {
      attempts.push(context.resume);
      if (scenario === 'stale legacy' && context.resume) throw new RuntimeMissingResultError(false, 'No session found');
      if (scenario === 'fresh retry fails') throw new Error('Runtime stream ended without a result');
      if (scenario === 'OIDC auth') throw new Error('WorkBuddy desktop authentication expired or invalid (Invalid OIDC token).');
      if (scenario === 'after send') { await context.send('Already published'); throw new RuntimeMissingResultError(false); }
      if (scenario === 'after tool') { await context.history(); throw new RuntimeMissingResultError(false); }
      if (scenario === 'after SDK tool') return consumeSdkQuery({ async *[Symbol.asyncIterator]() { yield { type: 'tool_progress', tool_name: 'Bash' }; } }, context);
      if (scenario === 'stale legacy') assert.equal(await saved(), undefined);
      await context.session(context.resume ?? 'new');
    }, { configDir: f.dir, cwd, runtime: 'Test', approvalTool: 'test', onError: e => errors.push(e) });
    t.after(async () => { await host.close(); bridge.close(); });
    await host.start(); await bridge.start(); f.send(frame);
    const idle = () => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle');
    await until(() => idle().length === 1);
    switch (scenario) {
      case 'changed cwd': assert.deepEqual(attempts, [undefined]); break;
      case 'stale legacy': case 'fresh retry fails': assert.deepEqual(attempts, ['saved', undefined]); break;
      default: assert.deepEqual(attempts, ['saved']);
    }
    if (['changed cwd', 'same cwd', 'stale legacy'].includes(scenario)) {
      assert.deepEqual(errors, []);
      const stored = await saved();
      assert.equal(stored.sessionId, scenario === 'same cwd' ? 'saved' : 'new');
      assert.equal(stored.cwd, cwd);
    } else {
      assert.match(idle()[0].params.errorMessage, /Invalid OIDC token|Runtime stream ended without a result/);
      assert.equal(errors.length, 1);
      assert.deepEqual(await saved(), scenario === 'fresh retry fails' ? undefined : entry);
    }
  });
}
