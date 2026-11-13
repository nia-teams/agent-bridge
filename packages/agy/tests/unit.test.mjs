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
import { fixture } from '../../core/tests/helpers.mjs';
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
  const context = { signal:controller.signal, send: async content => calls.push(['a',content]), history:async (limit,offset) => ({limit,offset}) };
  const scope = relay.register(context); const env = Object.fromEntries(scope.env.map(e => [e.name,e.value]));
  const call = (name,args,token=env.NIA_AGY_MCP_TOKEN) => callRelay(name,args,env.NIA_AGY_MCP_URL,token);
  assert.deepEqual(await call('nia_group_chat_send_message',{content:'hello'}),{sent:true});
  assert.deepEqual(await call('nia_group_chat_history',{}),{limit:50,offset:0});
  for (const [name,args] of [['unknown',{}],['nia_group_chat_send_message',{content:'x',group_chat_id:'other'}],['nia_group_chat_send_message',{content:' '}],['nia_group_chat_history',{limit:101}],['nia_group_chat_history',{offset:-1}]]) await assert.rejects(call(name,args));
  await assert.rejects(call('nia_group_chat_history',{},'wrong-token'));
  const other = relay.register({...context,send:async content=>calls.push(['b',content])});
  const otherEnv=Object.fromEntries(other.env.map(e=>[e.name,e.value]));
  await callRelay('nia_group_chat_send_message',{content:'other'},otherEnv.NIA_AGY_MCP_URL,otherEnv.NIA_AGY_MCP_TOKEN);
  assert.deepEqual(calls,[['a','hello'],['b','other']]);
  scope.revoke(); await assert.rejects(call('nia_group_chat_history',{}));
  controller.abort(); await assert.rejects(callRelay('nia_group_chat_history',{},otherEnv.NIA_AGY_MCP_URL,otherEnv.NIA_AGY_MCP_TOKEN));
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
