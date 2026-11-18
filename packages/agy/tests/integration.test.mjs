import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BridgeClient, SessionHost, stableExternalAgentThreadId } from '@nia-teams/agent-bridge-core';
import { createAgyRunner } from '../dist/index.js';
import { fixture, message, until, agentThreadId, teamId, contract } from '../../core/tests/helpers.mjs';
const binary = fileURLToPath(new URL('./mock-agy.mjs', import.meta.url));
const idles = f => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle');
const sends = f => f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message'));
async function setup(t, options = {}) {
  const cleanups = [];
  const f = await fixture({ after: fn => cleanups.push(fn) }), errors = [];
  // Give each child an isolated logging wrapper without modifying parent env or source fixtures.
  const log = `${f.dir}/acp.jsonl`, wrapper = `${f.dir}/agy`;
  await writeFile(log, '');
  await writeFile(wrapper, `#!/bin/sh\nexport AGY_TEST_LOG='${log}'\n${Object.entries(options.env ?? {}).map(([k,v]) => `export ${k}='${v}'`).join('\n')}\nexec '${process.execPath}' '${binary}' "$@"\n`, { mode: 0o755 });
  const runner = createAgyRunner({ cwd: f.dir, agyBin: wrapper, ...options });
  const bridge = new BridgeClient(f.credentials, { rpcTimeoutMs: 300, reconnectBaseMs: 10 });
  const host = new SessionHost(bridge, runner, { configDir: f.dir, runtime: 'Antigravity', approvalTool: 'agy.approval', approvalTimeoutMs: options.approvalTimeoutMs ?? 1500, fullAuto: options.fullAuto, onError: e => errors.push(e) });
  await host.start(); await bridge.start();
  t.after(async () => { bridge.close(); await host.close(); await runner.close(); for (const cleanup of cleanups) await cleanup(); });
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const idle = () => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle');
  return { f, bridge, host, runner, errors, events, idle };
}
test('ACP initialize, private streaming text/thoughts, durable resume and one persistent child', async t => {
  const { f, host, events, errors } = await setup(t);
  host.message(message('hello')); await until(() => idles(f).length >= 1, 'first reply', 10000);
  host.message(message('second')); await until(() => idles(f).length >= 2);
  const e = await events();
  assert.equal(e.filter(e => e.kind === 'spawn').length, 1);
  const init = e.find(e => e.method === 'initialize');
  assert.deepEqual(init.params, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'nia-agy', version: '0.3.0' } });
  const fresh = e.find(e => e.method === 'session/new'); assert.equal(fresh.params.systemPromptAppend, contract.systemPrompt);
  assert.ok(fresh.params.mcpServers[0].env.every(e => typeof e.name === 'string'));
  const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'));
  assert.equal(e.find(e => e.method === 'session/resume').params.sessionId, saved[agentThreadId].sessionId.slice(3));
  assert.deepEqual(sends(f), []);
  assert.ok(f.rpcs.some(r => r.params.label === 'Running Read project…'));
  assert.deepEqual(errors, []);
});
test('explicit resume JSON-RPC error starts a new session and replaces the mapping', async t => {
  const { f, host, events } = await setup(t, { env: { AGY_TEST_RESUME: 'error' } });
  host.message(message('first')); await until(() => idles(f).length >= 1, 'first reply', 10000);
  const first = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId;
  host.message(message('second')); await until(() => idles(f).length >= 2);
  assert.notEqual(JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId, first);
  assert.equal((await events()).filter(e => e.method === 'session/new').length, 2);
});
for (const verdict of ['approved','tampered','canceled','timeout']) test(`signed TaskBar permission ${verdict} selects the expected ACP option`, async t => {
  const { f, host, events, errors } = await setup(t, { approvalTimeoutMs: 250 });
  host.message(message('numeric permission'));
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
  const card = f.rpcs.find(r => r.method === 'card.upsert');
  assert.equal(card.params.verifyToolName, 'agy.approval');
  assert.equal(card.params.verifyArguments.tool, 'agy:run_command');
  if (verdict !== 'timeout') await f.confirm(card, { tamper: verdict === 'tampered', decision: verdict === 'canceled' ? 'canceled' : 'approved' });
  await until(() => idles(f).length >= 1, 'first reply', 10000);
  assert.equal((await events()).find(e => e.kind === 'response').frame.result.outcome.optionId, verdict === 'approved' ? 'allow' : 'deny');
  assert.deepEqual(sends(f), []);
  assert.equal((await events()).find(e => e.kind === 'response').frame.id, 1);
  assert.equal(errors.length > 0, verdict === 'tampered');
});
test('full-auto sets spawn flags and auto mode/model without creating a card', async t => {
  const { f, host, events } = await setup(t, { fullAuto: true, sandbox: true, model: 'test-model' });
  host.message(message('permission')); await until(() => idles(f).length >= 1, 'first reply', 10000);
  const e = await events();
  assert.deepEqual(e.find(e => e.kind === 'spawn').args, ['acp','--dangerously-skip-permissions','--sandbox']);
  assert.equal(e.find(e => e.method === 'session/set_mode').params.modeId, 'auto');
  assert.equal(e.find(e => e.method === 'session/set_model').params.modelId, 'test-model');
  assert.equal(sends(f).length, 0); assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
});
test('explicit plan mode takes precedence over the full-auto default', async t => {
  const { f, host, events } = await setup(t, { fullAuto: true, mode: 'plan' });
  host.message(message('hello')); await until(() => idles(f).length >= 1, 'first reply', 10000);
  assert.equal((await events()).find(e => e.method === 'session/set_mode').params.modeId, 'plan');
});
test('parallel chats multiplex streams and distinct sessions over the same child', async t => {
  const { f, host, events } = await setup(t);
  const group = 'abcdef123456abcdef123456';
  host.message(message('parallel-A'));
  host.message({ ...message('parallel-B'), groupChatId: group, agentThreadId: stableExternalAgentThreadId(group, teamId), sessionId: 'abcdefabcdefabcdefabcdef' });
  await until(() => idles(f).length >= 2);
  assert.equal(sends(f).length, 0);
  assert.equal(sends(f).length, 0);
  assert.equal((await events()).filter(e => e.kind === 'spawn').length, 1);
  const saved = Object.values(JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8')));
  assert.equal(new Set(saved.map(s => s.sessionId)).size, 2);
});
for (const ignore of [false,true]) test(`abort sends cancel, prevents stale publication and recovers (${ignore ? 'unresponsive child' : 'cooperative child'})`, { timeout: 10000 }, async t => {
  const { f, host, events } = await setup(t, { env: { AGY_TEST_IGNORE_CANCEL: ignore ? '1':'0' } });
  host.message(message('hold'));
  let ready = false;
  for (let i=0;i<200;i++) { if ((await events()).some(e => e.method==='session/prompt')) { ready = true; break; } await new Promise(r => setTimeout(r,20)); }
  assert.ok(ready, 'peer must record the active prompt before cancellation');
  host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  host.message(message('next'));
  await until(() => idles(f).length >= 1, 'post-abort reply', 7000);
  assert.equal(sends(f).length, 0);
  const e = await events(); assert.ok(e.some(e => e.method === 'session/cancel'));
  assert.equal(e.filter(e => e.kind === 'spawn').length, ignore ? 2 : 1);
});
test('child crash fails only the affected turns and a later request respawns cleanly', async t => {
  const { f, host, errors, events } = await setup(t);
  host.message(message('crash child')); await until(() => errors.length > 0);
  host.message(message('recover')); await until(() => idles(f).length >= 2, 'first reply', 10000);
  assert.equal((await events()).filter(e => e.kind === 'spawn').length, 2);
});
test('transport failure during resume does not silently create a replacement session', async t => {
  const { f, host, errors, events } = await setup(t, { env: { AGY_TEST_RESUME: 'crash' } });
  host.message(message('first')); await until(() => idles(f).length >= 1, 'first reply', 10000);
  host.message(message('second')); await until(() => errors.length > 0);
  assert.equal((await events()).filter(e => e.method === 'session/new').length, 1);
  assert.equal(sends(f).length, 0);
});
for (const env of [{ AGY_TEST_INIT:'malformed' }, { AGY_TEST_INIT:'wrong-version' }, { AGY_TEST_INIT:'hang' }, { AGY_TEST_NEW:'missing-id' }]) test(`malformed or failed startup is closed and never published: ${JSON.stringify(env)}`, async t => {
  const { f, host, errors } = await setup(t, { env, requestTimeoutMs: 150 });
  host.message(message('first')); await until(() => errors.length > 0);
  assert.equal(sends(f).length, 0);
});
test('resume identity mismatch does not publish or replace the saved mapping', async t => {
  const { f,host,errors }=await setup(t,{env:{AGY_TEST_RESUME:'mismatch'}});
  host.message(message('first'));await until(()=>idles(f).length >= 1,'first',10000);
  const before=await readFile(`${f.dir}/threads.json`,'utf8');
  host.message(message('second'));await until(()=>errors.length>0);
  assert.equal(sends(f).length,0);assert.equal(await readFile(`${f.dir}/threads.json`,'utf8'),before);
});
test('oversized assistant text is ignored and never published', async t => {
  const { f,host,errors }=await setup(t);host.message(message('oversized'));
  await until(()=>idles(f).length===1,'ignored output',10000);assert.equal(sends(f).length,0);
  host.message(message('recover'));await until(()=>idles(f).length >= 2,'recovered output',10000);
});
test('cancel during signed approval denies the pending tool and allows a subsequent silent turn', async t => {
  const {f,host,events}=await setup(t);host.message(message('permission'));
  await until(()=>f.rpcs.some(r=>r.method==='card.upsert'),'pending permission',10000);
  host.cancel({...message(),type:'thread.cancel',reason:'user_aborted'});
  host.message(message('next'));await until(()=>idles(f).length >= 1,'next',10000);
  assert.equal(sends(f).length, 0);
  assert.ok(f.rpcs.some(r=>r.method==='card.cancel'));
  assert.ok((await events()).some(e=>e.method==='session/cancel'));
});
test('full-auto cannot upgrade a protocol option to permanent allow', async t => {
  const {f,host,events}=await setup(t,{fullAuto:true});host.message(message('no once permission'));
  await until(()=>idles(f).length >= 1,'safe fallback',10000);
  assert.equal(sends(f).length, 0);
  assert.deepEqual((await events()).find(e=>e.kind==='response').frame.result,{outcome:{outcome:'cancelled'}});
});
test('abort while initialize is pending respects the two-second cancellation bound', { timeout: 8000 }, async t => {
  const { f,host,events,idle }=await setup(t,{env:{AGY_TEST_INIT:'hang'},requestTimeoutMs:10000});
  host.message(message('hello'));
  let ready=false;
  for(let i=0;i<200;i++){if((await events()).some(e=>e.method==='initialize')){ready=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.ok(ready);
  const start=Date.now();host.cancel({...message(),type:'thread.cancel',reason:'user_aborted'});
  await host.close();
  assert.ok(Date.now()-start<3500, 'host cleanup must not wait for the ten-second control timeout');assert.equal(sends(f).length,0);
});

test('real stdio MCP helper routes send/history and suppresses duplicate final text across resume', async t => {
  const { f, host, events, errors } = await setup(t);
  host.message(message('use tools')); await until(() => sends(f).length === 1, 'MCP send', 10000);
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  host.message(message('second-tools')); await until(() => sends(f).length === 2, 'resumed MCP send', 10000);
  await until(() => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle').length === 2, 'both MCP turns completed', 10000);
  assert.deepEqual(sends(f).map(r => r.params.arguments.content), ['ACP interim','Second scoped update']);
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'chat_history')).length, 2);
  assert.equal((await events()).filter(e => e.kind === 'send' && !e.result.isError).length, 2);
  assert.deepEqual(errors, []);
});


test('legacy ACP mapping starts v2 session; resumed reminder receives latest server prompt and exact tools', async t => {
  const { f, host, events } = await setup(t);
  await host.close();
  await writeFile(`${f.dir}/threads.json`, JSON.stringify({ [agentThreadId]: { sessionId: 'legacy-acp', groupChatId: message().groupChatId, updatedAt: 'now' } }), { mode: 0o600 });
  const bridge = new BridgeClient(f.credentials);
  const runner = createAgyRunner({ cwd: f.dir, agyBin: `${f.dir}/agy` });
  const upgraded = new SessionHost(bridge, runner, { configDir: f.dir, runtime: 'Antigravity', approvalTool: 'agy.approval' });
  t.after(async () => { await upgraded.close(); await runner.close(); bridge.close(); });
  await upgraded.start(); await bridge.start();
  const first = message(); f.send(first); await until(() => idles(f).length === 1);
  const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId;
  assert.ok(saved.startsWith('v2:'));
  const reminder = { ...message(), prompt: '<system-reminder>use tools to reply</system-reminder>' };
  f.send(reminder); await until(() => idles(f).length === 2, 'resumed reminder', 10000);
  const e = await events();
  assert.equal(e.filter(e => e.method === 'session/new').length, 1);
  assert.equal(e.find(e => e.method === 'session/resume').params.sessionId, saved.slice(3));
  assert.equal(e.find(e => e.method === 'session/resume').params.systemPromptAppend, contract.systemPrompt);
  assert.equal(e.filter(e => e.method === 'session/prompt')[1].params.prompt[0].text, reminder.prompt);
  assert.deepEqual(e.find(e => e.kind === 'tools').result.tools, contract.tools);
  assert.equal(idles(f)[1].params.deliveryId, reminder.deliveryId);
  assert.deepEqual(sends(f).map(r => r.params.arguments.content), ['ACP interim']);
});

test('AGY registers every server tool normally and preserves formatted content without loading hints', async t => {
  const { f, bridge, host, events, errors } = await setup(t);
  const tool = { name: 'future_tool', description: 'Future AGY tool', inputSchema: { type: 'object', properties: { value: { enum: ['new'] } } }, deferLoading: true };
  bridge.getContract().tools.push(tool);
  f.handleRpc = (frame, ws) => {
    if (frame.method !== 'tool.call' || frame.params.name !== tool.name) return false;
    ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: frame.requestId, ok: true, result: { content: '{"future":true}', isError: true } })); return true;
  };
  host.message(message('future tools')); await until(() => idles(f).length === 1);
  const records = await events(), listed = records.find(e => e.kind === 'tools').result.tools.find(t => t.name === tool.name);
  assert.deepEqual(listed.inputSchema, tool.inputSchema); assert.equal(listed.deferLoading, undefined);
  assert.deepEqual(records.find(e => e.kind === 'future').result, { content: [{ type: 'text', text: '{"future":true}' }], isError: true });
  assert.deepEqual(f.rpcs.find(r => r.params.name === tool.name).params.arguments, { value: 'new' });
  host.message(message('nia permission')); await until(() => idles(f).length === 2);
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  assert.deepEqual(errors, []);
});
