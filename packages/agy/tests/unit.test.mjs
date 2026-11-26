import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { permissionOption, AgyHost, resolveAgyBinary } from '../dist/host.js';
import { McpRelay, callRelay } from '../dist/mcp-relay.js';
import { fixture, contract, message, until } from '../../core/tests/helpers.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/nia-agy.mjs', import.meta.url));
test('permission decisions select only once options, preserve IDs and never widen to always', () => {
  const options = [{ optionId:'persist',kind:'allow_always' }, { optionId:'one-shot',kind:'allow_once' }, { optionId:'no',kind:'reject_once' }];
  assert.equal(permissionOption(options,true),'one-shot'); assert.equal(permissionOption(options,false),'no');
  assert.equal(permissionOption([{optionId:'allow',kind:'allow_always'}],true),undefined);
  assert.equal(permissionOption([{optionId:'allow'}],true),'allow');
  assert.equal(permissionOption([{optionId:'deny'}],false),'deny');
  for (const value of [null,{},[],[{optionId:3,kind:'allow_once'}]]) assert.equal(permissionOption(value,true),undefined);
});
test('invalid modes and nonpositive request timeouts fail before any process starts', () => {
  for (const options of [{mode:'unsafe'}, {requestTimeoutMs:0}, {promptTimeoutMs:-1}]) assert.throws(() => new AgyHost({}, { configDir: tmpdir(), cwd: tmpdir(), ...options }));
});
test('MCP loopback capabilities isolate sessions, reject destination injection and revoke on finish', async t => {
  const relay = new McpRelay(); await relay.start(); t.after(() => relay.close());
  const calls = [], controller = new AbortController();
  const context = { ...contract, signal:controller.signal, callTool: async (name, args) => {
    if (name === 'send_message') { if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('Empty message'); calls.push(['a', args.content]); return { content: '消息已发布到聊天' }; }
    return { content: JSON.stringify({ limit: args.limit ?? 50, offset: args.offset ?? 0 }) };
  } };
  let active = context;
  const scope = relay.register({ tools: contract.tools, current: () => active }); const env = Object.fromEntries(scope.env.map(e => [e.name,e.value]));
  const call = (name,args,token=env.NIA_AGY_MCP_TOKEN) => callRelay(name,args,env.NIA_AGY_MCP_URL,token);
  assert.deepEqual(await call('send_message',{content:'hello'}),{ content: '消息已发布到聊天' });
  assert.deepEqual(await call('chat_history',{}),{content:'{"limit":50,"offset":0}'});
  for (const [name,args] of [['unknown',{}],['send_message',{content:' '}]]) await assert.rejects(call(name,args));
  await assert.rejects(call('chat_history',{},'wrong-token'));
  assert.deepEqual(await call('chat_history',{}),{content:'{"limit":50,"offset":0}'});
  active = undefined; await assert.rejects(call('chat_history',{}), /Inactive tool scope/);
  active = context;
  const other = relay.register({ tools: contract.tools, current: () => ({ ...context, callTool: async (name,args) => { calls.push(['b',args.content]); return {content:'sent'}; } }) });
  const otherEnv=Object.fromEntries(other.env.map(e=>[e.name,e.value]));
  await callRelay('send_message',{content:'other'},otherEnv.NIA_AGY_MCP_URL,otherEnv.NIA_AGY_MCP_TOKEN);
  assert.deepEqual(calls,[['a','hello'],['b','other']]);
  scope.revoke(); await assert.rejects(call('chat_history',{}));
  controller.abort(); await assert.rejects(callRelay('chat_history',{},otherEnv.NIA_AGY_MCP_URL,otherEnv.NIA_AGY_MCP_TOKEN));
});
for (const url of ['https://127.0.0.1/tool','http://example.com/tool','http://127.0.0.1/wrong','http://user:pass@127.0.0.1/tool','http://127.0.0.1/tool?x=1']) test(`MCP helper rejects non-scoped endpoint ${url}`, async () => { await assert.rejects(callRelay('x',{},url,'token')); });
test('explicit binary discovery uses the selected executable and fails for missing paths', async t => {
  const dir=await mkdtemp(join(tmpdir(),'agy-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'agy');await writeFile(path,'#!/bin/sh\nexit 0\n',{mode:0o755});
  assert.equal(await resolveAgyBinary(path),path);
  await assert.rejects(resolveAgyBinary(join(dir,'missing')),/Cannot find agy/);
});
test('CLI help lists all commands; pair label/name aliases, private credentials and status work', async t => {
  const f=await fixture(t); f.pendingPolls=0;
  const help=(await exec(process.execPath,[cli,'--help'])).stdout;
  for (const flag of ['pair','status','start','--mode','--sandbox','--full-auto','--bypass-approvals','--agy-bin','--timeout-ms','--label']) assert.ok(help.includes(flag));
  await exec(process.execPath,[cli,'pair','--server-url',f.url,'--config-dir',f.dir,'--label','Label','--name','Name','--timeout-ms','3000']);
  f.credentials=JSON.parse(await readFile(join(f.dir,'credentials.json'),'utf8'));
  assert.equal(f.credentials.hostLabel,'Name');
  const status=(await exec(process.execPath,[cli,'status','--config-dir',f.dir])).stdout;
  assert.match(status,/Agent: Helper/);assert.ok(status.includes(f.url));assert.doesNotMatch(status,/PRIVATE KEY/);
  for (const args of [['start','--mode','bad'],['pair','--timeout-ms','0'],['unknown'],['start','--sandbox','bad']]) await assert.rejects(exec(process.execPath,[cli,...args]));
});

test('MCP stdio helper preserves relay tool errors, while callRelay still rejects', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const relay = new McpRelay(); await relay.start(); t.after(() => relay.close());
  const scope = relay.register({ tools: contract.tools, current: () => ({ signal: new AbortController().signal, callTool: async () => { throw new Error('Agent Bridge disconnected'); } }) });
  const env = Object.fromEntries(scope.env.map(e => [e.name, e.value]));
  await assert.rejects(callRelay('chat_history', {}, env.NIA_AGY_MCP_URL, env.NIA_AGY_MCP_TOKEN), /^Error: Agent Bridge disconnected$/);
  const client = new Client({ name: 'regression', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url))], env: { ...process.env, ...env } }));
  assert.deepEqual(await client.callTool({ name: 'chat_history', arguments: {} }), { isError: true, content: [{ type: 'text', text: 'Agent Bridge disconnected' }] });
});

test('ACP null prompt timeout arms no timer; control requests retain their default timeout and fail the generation', async t => {
  const { AcpClient } = await import('../dist/acp-client.js');
  const client = new AcpClient(process.execPath, ['-e', 'process.stdin.resume()'], 37);
  t.after(() => client.close());
  const original = globalThis.setTimeout, timers = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => { timers.push(args[1]); return original(...args); });
  const prompt = client.request('session/prompt', { sessionId: 'long' }, null);
  assert.deepEqual(timers, []);
  const init = client.request('initialize', {});
  assert.deepEqual(timers, [37]);
  await Promise.all([
    assert.rejects(init, /ACP request timeout: initialize/),
    assert.rejects(prompt, /ACP request timeout: initialize/),
  ]);
  assert.equal(client.available, false);
});

test('oversized explicit ACP request budgets clamp without overflow warnings or immediate generation failure', async t => {
  const { AcpClient } = await import('../dist/acp-client.js');
  const client = new AcpClient(process.execPath, ['-e', 'process.stdin.resume()'], 3_000_000_000);
  t.after(() => client.close());
  const warnings = [], delays = [], original = globalThis.setTimeout;
  const warning = value => { if (value.name === 'TimeoutOverflowWarning') warnings.push(value); };
  process.on('warning', warning); t.after(() => process.off('warning', warning));
  t.mock.method(globalThis, 'setTimeout', (...args) => { delays.push(args[1]); return original(...args); });
  const defaultBudget = assert.rejects(client.request('initialize', {}), /ACP child closed/);
  const explicitBudget = assert.rejects(client.request('session/new', {}, 4_000_000_000), /ACP child closed/);
  assert.deepEqual(delays, [2_147_483_647, 2_147_483_647]);
  await new Promise(resolve => original(resolve, 20));
  assert.equal(client.available, true);
  assert.deepEqual(warnings, []);
  await client.close(); await Promise.all([defaultBudget, explicitBudget]);
});

test('AgyHost retires older pending requests when the latest completes and applies only an explicit, clamped watchdog', async t => {
  const f = await fixture(t);
  const done = [], requests = [];
  const bridge = {
    credentials: f.credentials, getContract: () => contract,
    onReady: () => () => {}, onThreadMessage: () => () => {}, onThreadCancel: () => () => {}, onCardAction: () => () => {},
    async rpc(method, params) { if (method === 'thread.activity' && params.state === 'idle') done.push(params); return {}; },
  };
  const original = globalThis.setTimeout, delays = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => { delays.push(args[1]); return original(...args); });
  for (const promptTimeoutMs of [undefined, 3_000_000_000]) {
    const host = new AgyHost(bridge, { configDir: f.dir, cwd: f.dir, promptTimeoutMs });
    try {
      await host.start(); await host.relay.start();
      host.ready = async () => ({
        available: true,
        request(method, _params, timeout, signal) {
          if (method === 'session/new') return Promise.resolve({ sessionId: 'mock-session' });
          if (method === 'session/resume' || method === 'session/set_mode') return Promise.resolve({});
          let resolve, reject;
          const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
          const pending = { promise, resolve, reject };
          requests.push({ ...pending, timeout, signal });
          signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
          return pending.promise;
        },
      });
      const sent = requests.length;
      host.message(message('original'));
      await until(() => requests.length === sent + 1);
      const latest = message('steer'); host.message(latest);
      assert.equal(requests.length, sent + 2);
      const [older, newer] = requests.slice(sent);
      assert.equal(older.timeout, null); assert.equal(newer.timeout, null);
      newer.resolve({ stopReason: 'end_turn' });
      await until(() => done.at(-1)?.deliveryId === latest.deliveryId);
      assert.equal(older.signal.aborted, true);
      assert.equal(done.at(-1).errorMessage, undefined);
      assert.equal(delays.filter(delay => delay === 2_147_483_647).length, promptTimeoutMs ? 2 : 0);
    } finally { await host.close(); }
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function controlledHost(t, rpc, options = {}) {
  const f = await fixture(t), calls = [], errors = [];
  const bridge = {
    credentials: f.credentials, getContract: () => contract,
    onReady: () => () => {}, onThreadMessage: () => () => {}, onThreadCancel: () => () => {}, onCardAction: () => () => {},
    rpc: async (method, params, signal) => { calls.push({ method, params }); await rpc?.(method, params, signal); return {}; },
  };
  const host = new AgyHost(bridge, { configDir: f.dir, cwd: f.dir, onError: e => errors.push(e), ...options });
  t.after(() => host.close());
  await host.start(); await host.relay.start();
  return { host, calls, errors, dir: f.dir };
}

const abortFrame = frame => ({ ...frame, type: 'thread.cancel', reason: 'user_aborted' });

test('rotation aborts an old cancel-idle RPC and lets the replacement turn keep its activity and delivery', { timeout: 8000 }, async t => {
  const first = message('original'), next = { ...message('replacement'), sessionId: 'abcdefabcdefabcdefabcdef' };
  const oldIdle = deferred(), releaseIdle = deferred(), oldPrompt = deferred(), newPrompt = deferred();
  const delivered = [];
  t.after(() => { releaseIdle.resolve(); oldPrompt.resolve({ stopReason: 'cancelled' }); newPrompt.resolve({ stopReason: 'end_turn' }); });
  const { host, calls, errors } = await controlledHost(t, async (method, params, signal) => {
    if (method !== 'thread.activity' || params.state !== 'idle') return;
    if (params.sessionId === first.sessionId) { oldIdle.resolve(signal); await releaseIdle.promise; }
    signal.throwIfAborted(); delivered.push(params);
  });
  const prompts = [];
  let session = 0;
  host.ready = async () => ({
    available: true,
    notify() { oldPrompt.resolve({ stopReason: 'cancelled' }); },
    request: async (method, params) => {
      if (method === 'session/new') return { sessionId: `mock-${++session}` };
      if (method !== 'session/prompt') return {};
      prompts.push(params); return params.sessionId === 'mock-1' ? oldPrompt.promise : newPrompt.promise;
    },
  });
  host.message(first);
  await until(() => prompts.length === 1);
  const oldThread = host.threads.get(first.agentThreadId), retiring = oldThread.worker;
  await host.cancel(abortFrame(first));
  await until(() => calls.some(c => c.params.deliveryId === first.deliveryId));
  const idleSignal = await oldIdle.promise;
  host.message(next);
  await until(() => prompts.length === 2);
  const replacement = host.threads.get(next.agentThreadId), active = replacement.turn;
  assert.equal(idleSignal.aborted, true);
  releaseIdle.resolve(); await retiring;
  assert.equal(replacement.turn, active);
  assert.equal(active.controller.signal.aborted, false);
  assert.deepEqual(delivered, []);
  newPrompt.resolve({ stopReason: 'end_turn' });
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { sessionId: next.sessionId, state: 'idle', deliveryId: next.deliveryId });
  assert.deepEqual(errors, []);
});

for (const boundary of ['session/new', 'store.set']) test(`cancel at ${boundary} abandons setup and starts a fresh turn`, { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const { host, calls, errors, dir } = await controlledHost(t, undefined, { model: 'configured' });
  const requested = [];
  let n = 0;
  host.ready = async () => ({
    available: true,
    request: async (method, params) => {
      requested.push({ method, params });
      if (method === 'session/new') {
        const sessionId = `mock-${++n}`;
        if (n === 1 && boundary === 'session/new') { entered.resolve(); await release.promise; }
        return { sessionId };
      }
      return method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
    },
  });
  if (boundary === 'store.set') {
    const set = host.store.set.bind(host.store);
    host.store.set = async (id, entry) => {
      const write = set(id, entry);
      if (entry.sessionId === 'v2:mock-1') { entered.resolve(); await release.promise; }
      return write;
    };
  }
  const first = message('canceled opening'), next = message('fresh opening');
  host.message(first);
  await entered.promise;
  await host.cancel(abortFrame(first));
  host.message(next); release.resolve();
  await until(() => calls.some(c => c.params.deliveryId === next.deliveryId));
  assert.deepEqual(requested.filter(r => r.method === 'session/prompt').map(r => r.params.sessionId), ['mock-2']);
  assert.equal(requested.some(r => r.method === 'session/resume'), false);
  if (boundary === 'session/new') assert.equal(requested.some(r => r.params.sessionId === 'mock-1'), false);
  const stored = JSON.parse(await readFile(join(dir, 'threads.json'), 'utf8'))[next.agentThreadId];
  assert.equal(stored.sessionId, 'v2:mock-2');
  assert.deepEqual(calls.filter(c => c.params.state === 'idle').map(c => c.params.deliveryId), [first.deliveryId, next.deliveryId]);
  assert.deepEqual(errors, []);
});
