import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BridgeClient, stableExternalAgentThreadId } from '@nia-teams/agent-bridge-core';
import { CodexHost } from '../dist/index.js';
import { fixture, message, until, groupChatId, agentThreadId, sessionId, teamId, contract } from '../../core/tests/helpers.mjs';
const codexBin = fileURLToPath(new URL('./mock-codex.mjs', import.meta.url));
async function setup(t, options = {}) {
  const f = await fixture(t), errors = [];
  const bridge = new BridgeClient(f.credentials, { reconnectBaseMs: 10, rpcTimeoutMs: 200, onError: e => errors.push(e) });
  const host = new CodexHost(bridge, { configDir: f.dir, cwd: f.dir, codexBin, onError: e => errors.push(e), ...options });
  await host.start(); await bridge.start();
  t.after(async () => { await host.close(); bridge.close(); });
  const log = async () => (await host.app.request('test/log', {})).log;
  const emit = message => host.app.request('test/emit', { message });
  const active = async (content = 'hold') => {
    await host.message(message(content));
    const entries = await log(), start = entries.filter(m => m.method === 'turn/start').at(-1);
    return { threadId: start.params.threadId, turnId: `turn-${entries.filter(m => m.method === 'turn/start').length}` };
  };
  return { f, bridge, host, errors, log, emit, active };
}
async function waitResponse(log, id) {
  let entry; const end = Date.now() + 4000;
  while (!entry) {
    entry = (await log()).find(m => m.id === id && !m.method);
    if (Date.now() > end) throw new Error(`Missing response ${id}`);
    if (!entry) await new Promise(r => setTimeout(r, 5));
  }
  return entry;
}
const complete = (ids, items = [], error) => ({ method: 'turn/completed', params: { threadId: ids.threadId, turn: { id: ids.turnId, status: error ? 'failed' : 'completed', items, error } } });

test('stdio initialize → thread/start → turn/start → private agentMessage and idle; durable resume', async t => {
  const { f, host, log } = await setup(t);
  f.send(message('Hello'));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  const entries = await log();
  assert.deepEqual(entries.slice(0, 2).map(m => m.method), ['initialize', 'initialized']);
  assert.deepEqual(entries[0].params.clientInfo, { name: 'nia-teams-codex-bridge', title: 'Nia Teams Codex Bridge', version: '0.3.3' });
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length, 0);
  await host.message(message('second hold'));
  assert.equal((await log()).filter(m => m.method === 'thread/resume').length, 1);
  const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'));
  assert.equal(saved[agentThreadId].codexThreadId, 'codex-1');
  assert.equal((await stat(`${f.dir}/threads.json`)).mode & 0o777, 0o600);
});

test('dynamic tool request results use contentItems/inputText; history is session scoped; tool send suppresses duplicate final', async t => {
  const { f, log, emit, active } = await setup(t);
  const ids = await active();
  await emit({ id: 'history', method: 'item/tool/call', params: { ...ids, callId: 'h1', namespace: null, tool: 'chat_history', arguments: { limit: 10, offset: 2 } } });
  const history = await waitResponse(log, 'history');
  assert.equal(history.result.success, true); assert.equal(history.result.contentItems[0].type, 'inputText');
  assert.deepEqual(f.rpcs.find(r => (r.method === 'tool.call' && r.params.name === 'chat_history')).params, { sessionId, toolCallId: 'h1', name: 'chat_history', arguments: { limit: 10, offset: 2 } });
  await emit({ id: 'send', method: 'item/tool/call', params: { ...ids, callId: 's1', namespace: null, tool: 'send_message', arguments: { content: 'Progress update' } } });
  assert.equal((await waitResponse(log, 'send')).result.success, true);
  await emit(complete(ids, [{ type: 'agentMessage', id: 'a', text: 'Internal status note' }]));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  assert.deepEqual(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).map(r => r.params.arguments.content), ['Progress update']);
  await emit({ id: 'stale', method: 'item/tool/call', params: { ...ids, callId: 'stale', tool: 'send_message', arguments: { content: 'No' } } });
  assert.equal((await waitResponse(log, 'stale')).result.success, false);
});

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
  for (const outcome of ['valid', 'tampered', 'canceled']) {
    test(`${method}: ${outcome} RS256 confirmation → correct decision`, async t => {
      const { f, log, emit, active } = await setup(t, { fullAuto: false });
      const ids = await active();
      const legacy = !method.startsWith('item/');
      const params = legacy ? { conversationId: ids.threadId, callId: 'item-1', command: ['ls', '-la'], fileChanges: { '/example.txt': { type: 'add', content: 'hello' } }, cwd: f.dir } : { ...ids, itemId: 'item-1', startedAtMs: Date.now(), kind: 'command', environmentId: null, command: 'ls -la', cwd: f.dir };
      await emit({ id: 'approval', method, params });
      await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
      const card = f.rpcs.find(r => r.method === 'card.upsert');
      assert.equal(card.params.verifyToolName, 'codex.approval');
      assert.ok(f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'waiting'));
      await f.confirm(card, { tamper: outcome === 'tampered', decision: outcome === 'canceled' ? 'canceled' : 'approved' });
      const response = await waitResponse(log, 'approval');
      assert.deepEqual(response.result.decision, legacy ? (outcome === 'valid' ? 'approved' : { denied: { rejection: 'Not approved by Nia Teams' } }) : outcome === 'valid' ? 'accept' : 'decline');
      await until(() => f.rpcs.some(r => r.method === 'card.cancel'));
    });
  }
}

test('thread.cancel interrupts active turn and declines/cancels pending card', async t => {
  const { f, host, log, emit, active } = await setup(t, { fullAuto: false });
  const ids = await active();
  await emit({ id: 'pending', method: 'item/fileChange/requestApproval', params: { ...ids, itemId: 'file' } });
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
  await host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  assert.equal((await waitResponse(log, 'pending')).result.decision, 'decline');
  assert.deepEqual((await log()).find(m => m.method === 'turn/interrupt').params, ids);
  assert.ok(f.rpcs.some(r => r.method === 'card.cancel'));
  await emit(complete(ids, [{ type: 'agentMessage', id: 'stale', text: 'Do not publish' }]));
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length, 0);
});

test('steer includes expectedTurnId; rejected steering queues next turn; resume failure starts replacement', async t => {
  const { f, host, log, emit, active } = await setup(t);
  const ids = await active();
  await host.message(message('steer hold'));
  assert.equal((await log()).find(m => m.method === 'turn/steer').params.expectedTurnId, ids.turnId);
  await host.app.request('test/config', { rejectSteer: true, failResume: true });
  await host.message(message('queued hold'));
  await emit(complete(ids));
  let entries;
  for (let i = 0; i < 200; i++) { entries = await log(); if (entries.filter(m => m.method === 'turn/start').length === 2) break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal(entries.filter(m => m.method === 'turn/start').length, 2);
  assert.equal(entries.filter(m => m.method === 'thread/start').length, 2);
});

test('independent GroupChat threads, session rotation interrupts old turn, delta-only final and turn errors', async t => {
  const { f, host, log, emit, active } = await setup(t);
  const first = await active();
  const otherGroup = 'abcdefabcdefabcdefabcdef';
  const other = { ...message('hold other'), groupChatId: otherGroup, agentThreadId: stableExternalAgentThreadId(otherGroup, teamId) };
  await host.message(other);
  assert.equal((await log()).filter(m => m.method === 'thread/start').length, 2);
  const rotated = { ...message('hold rotated'), sessionId: 'abcdef123456abcdef123456' };
  await host.message(rotated);
  assert.ok((await log()).some(m => m.method === 'turn/interrupt' && m.params.turnId === first.turnId));
  const ids = { threadId: 'codex-1', turnId: 'turn-3' };
  await emit({ method: 'item/agentMessage/delta', params: { ...ids, itemId: 'delta', delta: 'From delta' } });
  await emit(complete(ids));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle' && r.params.deliveryId === rotated.deliveryId));
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length, 0);
  await emit(complete({ threadId: 'codex-2', turnId: 'turn-2' }, [], { message: 'Model failed' }));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.errorMessage === 'Model failed'));
});

test('opt-in approval uses read-only and on-request; timeout declines', async t => {
  const { f, log, emit, active } = await setup(t, { fullAuto: false, approvalTimeoutMs: 40 });
  const ids = await active();
  const start = (await log()).find(m => m.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'on-request'); assert.equal(start.params.sandbox, 'read-only');
  await emit({ id: 'timeout', method: 'item/commandExecution/requestApproval', params: { ...ids, itemId: 'c', command: 'pwd' } });
  assert.equal((await waitResponse(log, 'timeout')).result.decision, 'decline');
  assert.ok(f.rpcs.some(r => r.method === 'card.cancel'));
});

test('default full-auto and sends accept without creating cards', async t => {
  const { f, log, emit, active } = await setup(t);
  const ids = await active();
  const start = (await log()).find(m => m.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'workspace-write');
  await emit({ id: 'auto', method: 'item/commandExecution/requestApproval', params: { ...ids } });
  assert.equal((await waitResponse(log, 'auto')).result.decision, 'accept');
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
});

test('explicit sandbox overrides the full-auto default', async t => {
  const { log, active } = await setup(t, { sandbox: 'read-only' });
  await active();
  const { params } = (await log()).find(m => m.method === 'thread/start');
  assert.equal(params.approvalPolicy, 'never'); assert.equal(params.sandbox, 'read-only');
});

test('persisted GroupChat mapping resumes after host restart rather than starting another thread', async t => {
  const { f, bridge, host } = await setup(t);
  await host.message(message('hold before restart'));
  await host.close();
  const restarted = new CodexHost(bridge, { configDir: f.dir, cwd: f.dir, codexBin });
  t.after(() => restarted.close());
  await restarted.start();
  await restarted.message(message('hold after restart'));
  const { log } = await restarted.app.request('test/log', {});
  assert.equal(log.filter(m => m.method === 'thread/start').length, 0);
  assert.equal(log.find(m => m.method === 'thread/resume').params.threadId, 'codex-1');
});

test('cancellation interrupts a turn blocked on final idle without stalling the thread lock', async t => {
  const { f, host, log, emit, active } = await setup(t);
  const ids = await active();
  f.holdRpc.add('thread.activity');
  await emit(complete(ids, [{ type: 'agentMessage', id: 'a', text: 'Pending publication' }]));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  f.send({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  const end = Date.now() + 4000;
  while (!(await log()).some(m => m.method === 'turn/interrupt')) {
    if (Date.now() > end) throw new Error('Cancellation blocked behind publication');
    await new Promise(r => setTimeout(r, 5));
  }
  f.holdRpc.delete('thread.activity');
  await host.message(message('hold next'));
  assert.equal((await log()).filter(m => m.method === 'turn/start').length, 2);
});

test('file approval preview comes from item lifecycle, and unknown server requests fail closed', async t => {
  const { f, log, emit, active } = await setup(t, { fullAuto: false });
  const ids = await active();
  await emit({ method: 'item/started', params: { ...ids, item: { id: 'patch', type: 'fileChange', changes: [{ path: '/example.txt', diff: '+new content' }] } } });
  await emit({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { ...ids, itemId: 'patch', startedAtMs: Date.now() } });
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
  const card = f.rpcs.find(r => r.method === 'card.upsert');
  assert.match(card.params.description, /example.txt/); assert.match(card.params.description, /new content/);
  await emit({ id: 'unknown', method: 'item/unknown/requestApproval', params: ids });
  assert.equal((await waitResponse(log, 'unknown')).error.code, -32601);
});


test('v2 contract, server reminder and upgrade safety start fresh instead of resuming legacy tools', async t => {
  const { f, host, log } = await setup(t);
  await writeFile(`${f.dir}/threads.json`, JSON.stringify({ [agentThreadId]: { codexThreadId: 'old-tools', groupChatId, updatedAt: 'now' } }), { mode: 0o600 });
  // Reload through a new host, as on a real upgrade.
  await host.close();
  const bridge = new BridgeClient(f.credentials);
  const restarted = new CodexHost(bridge, { configDir: f.dir, cwd: f.dir, codexBin });
  t.after(async () => { await restarted.close(); bridge.close(); });
  await restarted.start(); await bridge.start();
  const first = message(); f.send(first);
  const idle = () => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === 'idle');
  await until(() => idle().length === 1);
  const reminder = { ...message(), prompt: '<system-reminder>Publish a reply.</system-reminder>' };
  f.send(reminder); await until(() => idle().length === 2);
  const entries = (await restarted.app.request('test/log', {})).log;
  const start = entries.find(e => e.method === 'thread/start');
  assert.deepEqual(start.params.dynamicTools, contract.tools.map(t => ({ type: 'function', ...t })));
  assert.equal(start.params.developerInstructions, contract.systemPrompt);
  assert.equal(entries.filter(e => e.method === 'thread/resume').length, 1);
  assert.notEqual(entries.find(e => e.method === 'thread/resume').params.threadId, 'old-tools');
  assert.equal(entries.filter(e => e.method === 'turn/start')[1].params.input[0].text, reminder.prompt);
  assert.equal(idle()[1].params.deliveryId, reminder.deliveryId);
  assert.equal(f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length, 0);
});

for (const provider of ['openai', 'deepseek']) test(`provider ${provider}: deferred handshake tool, direct string output, error and snapshot refresh`, async t => {
  const { f, bridge, host, log, emit, active } = await setup(t);
  await host.app.request('test/config', { provider });
  const tool = { name: 'future_tool', description: 'Server addition', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, deferLoading: true };
  bridge.getContract().tools.push(tool);
  const ids = await active();
  let entries = await log();
  const dynamic = entries.find(m => m.method === 'thread/start').params.dynamicTools;
  if (provider === 'openai') {
    assert.equal(dynamic.at(-1).type, 'namespace');
    assert.equal(dynamic.at(-1).name, 'nia');
    assert.equal(dynamic.at(-1).tools[0].name, tool.name);
    assert.deepEqual(dynamic.at(-1).tools[0].inputSchema, tool.inputSchema);
    assert.equal(dynamic.at(-1).tools[0].deferLoading, true);
  } else {
    assert.equal(dynamic.at(-1).type, 'function');
    assert.equal(dynamic.at(-1).name, tool.name);
    assert.deepEqual(dynamic.at(-1).inputSchema, tool.inputSchema);
    assert.equal(dynamic.at(-1).deferLoading, undefined);
  }
  assert.ok(entries.findIndex(m => m.method === 'config/read') < entries.findIndex(m => m.method === 'thread/start'));
  f.handleRpc = (frame, ws) => {
    if (frame.method !== 'tool.call' || frame.params.name !== tool.name) return false;
    ws.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: frame.requestId, ok: true, result: { content: '{"formatted":true}', isError: true } })); return true;
  };
  await emit({ id: 'future', method: 'item/tool/call', params: { ...ids, callId: 'future-id', namespace: provider === 'openai' ? 'nia' : null, tool: tool.name, arguments: { value: 'x' } } });
  const result = (await waitResponse(log, 'future')).result;
  assert.deepEqual(result, { contentItems: [{ type: 'inputText', text: '{"formatted":true}' }], success: false });
  await emit({ id: 'wrong-ns', method: 'item/tool/call', params: { ...ids, callId: 'wrong-ns-id', namespace: 'other', tool: tool.name, arguments: { value: 'x' } } });
  assert.equal((await waitResponse(log, 'wrong-ns')).result.success, false);
  const rpc = f.rpcs.find(r => r.params.name === tool.name); assert.equal(rpc.params.toolCallId, 'future-id'); assert.deepEqual(rpc.params.arguments, { value: 'x' });
  await emit(complete(ids)); await until(() => f.rpcs.some(r => r.params.state === 'idle'));
  const stored = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId]; assert.match(stored.toolsFingerprint, /^[a-f0-9]{64}$/); assert.equal(stored.protocolVersion, 3);
  bridge.getContract().tools.at(-1).description = 'Changed schema description';
  const next = await active(); entries = await log();
  assert.notEqual(next.threadId, ids.threadId);
  assert.equal(entries.filter(m => m.method === 'thread/start').length, 2);
  assert.equal(entries.filter(m => m.method === 'thread/resume').length, 0);
});

for (const outcome of ['complete', 'cancel']) test(`Codex executing/waiting leases renew and reconnect, then stop on ${outcome}`, async t => {
  const { f, host, emit, active } = await setup(t, { fullAuto: false, activityRefreshMs: 40 });
  const ids = await active();
  const activities = state => f.rpcs.filter(r => r.method === 'thread.activity' && r.params.state === state);
  await until(() => activities('executing').length >= 3);
  let connections = f.connections;
  f.socket.terminate(); await until(() => f.connections > connections);
  await until(() => activities('executing').length >= 4);
  await emit({ id: 'lease-approval', method: 'item/fileChange/requestApproval', params: { ...ids, itemId: 'file' } });
  await until(() => activities('waiting').length >= 3);
  connections = f.connections;
  f.socket.terminate(); await until(() => f.connections > connections);
  await until(() => activities('waiting').length >= 4);
  if (outcome === 'complete') await emit(complete(ids));
  else await host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  await until(() => activities('idle').length > 0);
  const count = f.rpcs.filter(r => r.method === 'thread.activity').length;
  f.socket.terminate();
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(f.rpcs.filter(r => r.method === 'thread.activity').length, count);
});

test('parallel Codex item activity supersedes a pending send publication and lease revision', async t => {
  const { f, emit, active, log } = await setup(t, { activityRefreshMs: 40 });
  const ids = await active(); f.holdRpc.add('tool.call');
  await emit({ id: 'held-send', method: 'item/tool/call', params: { ...ids, callId: 'held-send', tool: 'send_message', arguments: { content: 'Progress' } } });
  await until(() => f.rpcs.some(r => r.params.toolCallId === 'held-send'));
  const held = f.rpcs.find(r => r.params.toolCallId === 'held-send');
  await emit({ method: 'item/started', params: { ...ids, item: { id: 'command', type: 'commandExecution' } } });
  await until(() => f.rpcs.some(r => r.params.label === 'Running command…'));
  const offset = f.rpcs.length;
  f.socket.send(JSON.stringify({ type: 'rpc.response', protocolVersion: 3, requestId: held.requestId, ok: true, result: { published: true } }));
  await waitResponse(log, 'held-send');
  await until(() => f.rpcs.slice(offset).some(r => r.method === 'thread.activity'));
  assert.ok(f.rpcs.slice(offset).filter(r => r.method === 'thread.activity').every(r => r.params.label === 'Running command…'));
});
