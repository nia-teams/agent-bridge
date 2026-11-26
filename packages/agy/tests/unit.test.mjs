import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { permissionOption, AgyRunner, resolveAgyBinary } from '../dist/runner.js';
import { McpRelay, callRelay } from '../dist/mcp-relay.js';
import { fixture, contract } from '../../core/tests/helpers.mjs';
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
  for (const options of [{mode:'unsafe'}, {requestTimeoutMs:0}, {promptTimeoutMs:-1}]) assert.throws(() => new AgyRunner({cwd:tmpdir(),...options}));
});
test('MCP loopback capabilities isolate turns, reject destination injection and revoke on finish', async t => {
  const relay = new McpRelay(); await relay.start(); t.after(() => relay.close());
  const calls = [], controller = new AbortController();
  const context = { ...contract, signal:controller.signal, callTool: async (name, args) => {
    if (name === 'send_message') { if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('Empty message'); calls.push(['a', args.content]); return { content: '消息已发布到聊天' }; }
    return { content: JSON.stringify({ limit: args.limit ?? 50, offset: args.offset ?? 0 }) };
  } };
  const scope = relay.register(context); const env = Object.fromEntries(scope.env.map(e => [e.name,e.value]));
  const call = (name,args,token=env.NIA_AGY_MCP_TOKEN) => callRelay(name,args,env.NIA_AGY_MCP_URL,token);
  assert.deepEqual(await call('send_message',{content:'hello'}),{ content: '消息已发布到聊天' });
  assert.deepEqual(await call('chat_history',{}),{content:'{"limit":50,"offset":0}'});
  for (const [name,args] of [['unknown',{}],['send_message',{content:' '}]]) await assert.rejects(call(name,args));
  await assert.rejects(call('chat_history',{},'wrong-token'));
  const other = relay.register({...context,callTool:async (name,args)=>{ calls.push(['b',args.content]); return {content:'sent'}; }});
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

test('default runner prompt has no wall-clock timer and explicitly disables the ACP request timer', async t => {
  const runner = new AgyRunner({ cwd: tmpdir(), requestTimeoutMs: 25 });
  t.after(() => runner.close());
  await runner.relay.start();
  let finish, prompting;
  const started = new Promise(resolve => { prompting = resolve; });
  const requests = [], timers = [];
  const client = {
    available: true,
    request(method, params, timeout) {
      requests.push({ method, timeout });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'long-turn' });
      if (method === 'session/set_mode') return Promise.resolve({});
      prompting(); return new Promise(resolve => { finish = resolve; });
    },
  };
  runner.ready = async () => client;
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { timers.push(args[1]); return original(...args); });
  const turn = runner.run({ ...contract, signal: new AbortController().signal, prompt: 'long task', session: async () => {} });
  await started;
  assert.deepEqual(requests, [{ method: 'session/new', timeout: undefined }, { method: 'session/set_mode', timeout: undefined }, { method: 'session/prompt', timeout: null }]);
  assert.deepEqual(timers, [], 'runner must not arm any default prompt wall-clock timer');
  finish({ stopReason: 'end_turn' }); await turn;
});

test('MCP stdio helper preserves relay tool errors, while callRelay still rejects', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const relay = new McpRelay(); await relay.start(); t.after(() => relay.close());
  const scope = relay.register({ ...contract, signal: new AbortController().signal, callTool: async () => { throw new Error('Agent Bridge disconnected'); } });
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

test('oversized explicit AGY prompt budget clamps without immediate cancellation or overflow warnings', async t => {
  const runner = new AgyRunner({ cwd: tmpdir(), promptTimeoutMs: 3_000_000_000 });
  t.after(() => runner.close()); await runner.relay.start();
  const warnings = [], delays = [], original = globalThis.setTimeout;
  const warning = value => { if (value.name === 'TimeoutOverflowWarning') warnings.push(value); };
  process.on('warning', warning); t.after(() => process.off('warning', warning));
  t.mock.method(globalThis, 'setTimeout', (...args) => { delays.push(args[1]); return original(...args); });
  let finish, started;
  const prompting = new Promise(resolve => { started = resolve; });
  runner.ready = async () => ({
    available: true,
    notify() { assert.fail('oversized prompt budget must not cancel immediately'); },
    request(method) {
      if (method === 'session/new') return Promise.resolve({ sessionId: 'large-budget' });
      if (method === 'session/set_mode') return Promise.resolve({});
      started(); return new Promise(resolve => { finish = resolve; });
    },
  });
  const turn = runner.run({ ...contract, signal: new AbortController().signal, prompt: 'long task', session: async () => {} });
  await prompting;
  assert.deepEqual(delays, [2_147_483_647]);
  await new Promise(resolve => original(resolve, 20));
  finish({ stopReason: 'end_turn' }); await turn;
  assert.deepEqual(warnings, []);
});
