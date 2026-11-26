import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BridgeClient, SessionHost } from '@nia-teams/agent-bridge-core';
import { fixture, message, until, agentThreadId, contract } from '../../core/tests/helpers.mjs';
import { createDroidRunner } from '../dist/runner.js';
const binary = fileURLToPath(new URL('./mock-droid.mjs', import.meta.url));
await chmod(binary, 0o755);
const idle = f => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle');
const sends = f => f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message'));
async function setup(t, options = {}) {
  const f = await fixture(t), errors = [], contexts = [];
  const bridge = new BridgeClient(f.credentials, { rpcTimeoutMs: 300, reconnectBaseMs: 10 });
  const runner = createDroidRunner({ cwd: f.dir, droidBin: binary, ...options });
  const host = new SessionHost(bridge, context => { contexts.push(context); return runner(context); }, { configDir: f.dir, runtime: 'Factory Droid', approvalTool: 'droid.approval', approvalTimeoutMs: 1000, onError: error => errors.push(error), ...options });
  await host.start(); await bridge.start();
  t.after(async () => { await host.close(); bridge.close(); });
  const logs = async () => (await readFile(`${f.dir}/mock-log.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
  const done = async n => until(() => idle(f).length >= n, 'Droid idle', 10000);
  return { f, bridge, errors, host, contexts, logs, done };
}
test('native SDK initializes, preserves private text, routes MCP, resumes durably and recovers only missing sessions', async t => {
  const { f, host, errors, logs, contexts, done } = await setup(t);
  host.message(message('hello')); await done(1);
  assert.equal(sends(f).length, 0);
  let events = await logs();
  const init = events.find(e => e.frame?.method === 'droid.initialize_session').frame.params;
  assert.equal(init.autonomyLevel, 'high');
  assert.deepEqual(init.systemPrompt, { type: 'preset', preset: 'droid', append: contract.systemPrompt });
  assert.equal(events.find(e => e.started).disableUpdate, 'true');
  const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId;
  host.message({ ...message(), prompt: '<system-reminder>use tools</system-reminder>' }); await done(2);
  assert.equal(contexts[1].resume, saved);
  events = await logs(); assert.ok(events.some(e => e.frame?.method === 'droid.load_session'));
  assert.deepEqual(sends(f).map(r => r.params.arguments.content), ['Droid interim']);
  assert.equal(f.rpcs.find(r => (r.method === 'tool.call' && r.params.name === 'chat_history')).params.arguments.limit, 2);
  assert.equal(events.find(e => e.tools).tools.tools.find(tool => tool.name === 'send_message').description, contract.tools[0].description);
  assert.deepEqual(events.find(e => e.tools).tools.tools.find(tool => tool.name === 'chat_history').inputSchema, contract.tools[1].inputSchema);
  await unlink(`${f.dir}/mock-session-${saved}.json`);
  host.message(message('third')); await done(3);
  const fresh = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId;
  assert.notEqual(fresh, saved);
  events = await logs(); assert.equal(events.filter(e => e.frame?.method === 'droid.initialize_session').length, 2);
  assert.equal(events.filter(e => e.frame?.method === 'droid.add_user_message').length, 3);
  assert.deepEqual(errors, []);
  for (const event of events.filter(e => e.started)) assert.throws(() => process.kill(event.pid, 0), /ESRCH/);
  for (const event of events.filter(e => e.mcp)) await assert.rejects(fetch(event.mcp.url));
});
for (const outcome of ['approved', 'tampered', 'canceled', 'timeout']) test(`signed TaskBar ${outcome} produces one-shot approval or cancellation`, async t => {
  const { f, host, errors, logs, done } = await setup(t, { fullAuto: false });
  host.message(message('permission spoof'));
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'), 'permission card', 10000);
  const card = f.rpcs.find(r => r.method === 'card.upsert');
  assert.equal(card.params.verifyToolName, 'droid.approval');
  assert.match(JSON.stringify(card), /droid:AskUserQuestion/);
  assert.deepEqual(card.params.verifyArguments.input.input, { command: 'echo test' });
  if (outcome !== 'timeout') await f.confirm(card, { tamper: outcome === 'tampered', decision: outcome === 'canceled' ? 'canceled' : 'approved' });
  await done(1);
  const result = (await logs()).find(e => e.permissionResult)?.permissionResult;
  assert.equal(result?.selectedOption, outcome === 'approved' ? 'proceed_once' : 'cancel');
  assert.equal(sends(f).length, 0);
  assert.equal(errors.length > 0, outcome === 'tampered');
});
for (const [prompt, options] of [['collaboration', { fullAuto: false }], ['collaboration scoped', { fullAuto: false }], ['collaboration mcp', { fullAuto: false }], ['permission', {}]]) test(`${prompt}: permitted tools bypass TaskBar only at the intended boundary`, async t => {
  const { f, host, logs, done, errors } = await setup(t, options); host.message(message(prompt)); await done(1);
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  assert.equal((await logs()).find(e => e.permissionResult).permissionResult.selectedOption, 'proceed_once');
  assert.deepEqual(errors, []);
});
for (const [fullAuto, answer] of [[false, 'Blue'], [true, 'Blue'], [false, 'A custom color not listed']]) test(`AskUser preserves option or free-text answers (fullAuto=${fullAuto}, answer=${answer})`, async t => {
  const { f, host, logs, done, errors } = await setup(t, { fullAuto }); host.message(message('question'));
  await until(() => sends(f).length === 1, 'question', 10000); assert.match(sends(f)[0].params.arguments.content, /Choose a color/);
  host.message(message(answer)); await done(1);
  assert.deepEqual((await logs()).find(e => e.askResult).askResult.answers, [{ index: 1, question: 'Choose a color', answer }]);
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0); assert.deepEqual(errors, []);
});
test('thread.cancel interrupts the native session and tears down child and MCP resources', async t => {
  const { f, host, logs, done } = await setup(t); host.message(message('hold'));
  // Wait for prompt dispatch, not just SessionHost executing activity.
  for (let i = 0; i < 200; i++) { if ((await logs().catch(() => [])).some(e => e.frame?.method === 'droid.add_user_message')) break; await new Promise(r => setTimeout(r, 5)); }
  host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  host.message(message('next')); await done(1);
  const events = await logs(); assert.ok(events.some(e => e.interrupted));
  assert.equal(sends(f).length, 0);
  for (const event of events.filter(e => e.started)) assert.throws(() => process.kill(event.pid, 0), /ESRCH/);
});
test('failed streams surface an error without replaying the prompt', async t => {
  const { host, logs, errors, done } = await setup(t); host.message(message('fail turn')); await done(1);
  assert.equal(errors.length, 1); assert.equal((await logs()).filter(e => e.frame?.method === 'droid.add_user_message').length, 1);
});
test('explicit autonomy overrides default full-auto at session creation and resume', async t => {
  const { host, logs, done, errors } = await setup(t, { model: 'mock-custom', effort: 'high', autonomy: 'low' });
  host.message(message()); await done(1); host.message(message('second')); await done(2);
  const entries = await logs();
  assert.equal(entries.find(e => e.frame?.method === 'droid.initialize_session').frame.params.autonomyLevel, 'low');
  const params = entries.find(e => e.frame?.method === 'droid.update_session_settings').frame.params;
  assert.equal(params.modelId, 'mock-custom'); assert.equal(params.reasoningEffort, 'high'); assert.equal(params.autonomyLevel, 'low'); assert.deepEqual(errors, []);
});

test('non-missing load errors fail without creating or prompting a replacement session', async t => {
  const { f, host, logs, done, errors } = await setup(t);
  host.message(message('first')); await done(1);
  await writeFile(`${f.dir}/mock-load-error`, 'true');
  host.message(message('second')); await done(2);
  const events = await logs();
  assert.equal(events.filter(e => e.frame?.method === 'droid.initialize_session').length,1);
  assert.equal(events.filter(e => e.frame?.method === 'droid.add_user_message').length,1);
  assert.equal(errors.length,1);
});
test('native child exit fails the turn and does not replay the prompt', async t => {
  const { host, logs, done, errors } = await setup(t);
  host.message(message('crash turn')); await done(1);
  const events=await logs();assert.equal(events.filter(e => e.started).length,1);
  assert.equal(events.filter(e => e.frame?.method === 'droid.add_user_message').length,1);
  assert.equal(errors.length,1);
});
test('AskUser timeout returns cancellation to the native client', async t => {
  const { host, logs, done, errors } = await setup(t);
  host.message(message('question')); await done(1);
  assert.deepEqual((await logs()).find(e => e.askResult).askResult,{cancelled:true,answers:[]});
  assert.deepEqual(errors,[]);
});

test('AskUser preserves indexed multi-question option and custom free-text answers through the real SDK', async t => {
  const { f, host, logs, done, errors } = await setup(t);
  host.message(message('multi-question'));
  await until(() => sends(f).length === 1, 'multi-question publication', 10000);
  const content = sends(f)[0].params.arguments.content;
  for (const label of ['Choose a color', '- Blue', '- Red', 'Describe the task', 'JSON object keyed by question text']) assert.ok(content.includes(label));
  host.message(message(JSON.stringify({ 'Choose a color': 'Blue', 'Describe the task': 'Review the patch, then explain the trade-offs.' })));
  await done(1);
  assert.deepEqual((await logs()).find(e => e.askResult).askResult, { answers: [
    { index: 2, question: 'Choose a color', answer: 'Blue' },
    { index: 5, question: 'Describe the task', answer: 'Review the patch, then explain the trade-offs.' },
  ] });
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  assert.deepEqual(errors, []);
});
test('optional history arguments are forwarded verbatim for server-side defaults', async t => {
  const { f, host, done, errors } = await setup(t);
  host.message(message('use tools default history')); await done(1);
  const params = f.rpcs.find(r => (r.method === 'tool.call' && r.params.name === 'chat_history')).params;
  assert.deepEqual(params.arguments, {}); assert.equal(params.name, 'chat_history');
  assert.deepEqual(errors, []);
});

test('native external MCP lists and calls future deferred tools with raw schemas and no local approval', async t => {
  const { f, bridge, host, logs, done, errors } = await setup(t);
  const tool = { name: 'future_tool', description: 'Future Droid tool', inputSchema: { type: 'object', properties: { value: { enum: ['new'] } } }, deferLoading: true };
  bridge.getContract().tools.push(tool);
  f.handleRpc = (frame, ws) => {
    if (frame.method !== 'tool.call' || frame.params.name !== tool.name) return false;
    ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: frame.requestId, ok: true, result: { content: '{"future":true}' } })); return true;
  };
  host.message(message('future tools collaboration future')); await done(1);
  const events = await logs(), listed = events.find(e => e.tools).tools.tools.find(t => t.name === tool.name);
  assert.deepEqual(listed.inputSchema, tool.inputSchema); assert.equal(listed.deferLoading, undefined);
  assert.ok(events.some(e => e.mcpResult?.content?.[0]?.text === '{"future":true}'));
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  assert.deepEqual(f.rpcs.find(r => r.params.name === tool.name).params.arguments, { value: 'new' });
  assert.deepEqual(errors, []);
});
