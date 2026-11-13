import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BridgeClient, stableExternalAgentThreadId } from '@nia-teams/agent-bridge-core';
import { CodexHost } from '../dist/index.js';
import { fixture, message, until, groupChatId, agentThreadId, sessionId, teamId } from '../../core/tests/helpers.mjs';
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

test('stdio initialize → thread/start → turn/start → agentMessage → publication and idle; resume and durable mappings', async t => {
  const { f, host, log } = await setup(t);
  f.send(message('Hello'));
  await until(() => f.rpcs.some(r => r.method === 'group_chat.send_message'));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  const entries = await log();
  assert.deepEqual(entries.slice(0, 2).map(m => m.method), ['initialize', 'initialized']);
  assert.deepEqual(entries[0].params.clientInfo, { name: 'nia-teams-codex-bridge', title: 'Nia Teams Codex Bridge', version: '0.1.0' });
  assert.equal(f.rpcs.find(r => r.method === 'group_chat.send_message').params.content, 'Hello from Codex');
  assert.match(f.rpcs.find(r => r.method === 'group_chat.send_message').params.toolCallId, /^turn:codex-1:turn-1$/);
  await host.message(message('second hold'));
  assert.equal((await log()).filter(m => m.method === 'thread/resume').length, 1);
  const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'));
  assert.equal(saved[agentThreadId].codexThreadId, 'codex-1');
  assert.equal((await stat(`${f.dir}/threads.json`)).mode & 0o777, 0o600);
});

test('dynamic tool request results use contentItems/inputText; history is session scoped; tool send suppresses duplicate final', async t => {
  const { f, log, emit, active } = await setup(t);
  const ids = await active();
  await emit({ id: 'history', method: 'item/tool/call', params: { ...ids, callId: 'h1', namespace: null, tool: 'nia_group_chat_history', arguments: { limit: 10, offset: 2 } } });
  const history = await waitResponse(log, 'history');
  assert.equal(history.result.success, true); assert.equal(history.result.contentItems[0].type, 'inputText');
  assert.deepEqual(f.rpcs.find(r => r.method === 'group_chat.history').params, { sessionId, limit: 10, offset: 2 });
  await emit({ id: 'send', method: 'item/tool/call', params: { ...ids, callId: 's1', namespace: null, tool: 'nia_group_chat_send_message', arguments: { content: 'Progress update' } } });
  assert.equal((await waitResponse(log, 'send')).result.success, true);
  await emit(complete(ids, [{ type: 'agentMessage', id: 'a', text: 'Internal status note' }]));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  assert.deepEqual(f.rpcs.filter(r => r.method === 'group_chat.send_message').map(r => r.params.content), ['Progress update']);
  await emit({ id: 'stale', method: 'item/tool/call', params: { ...ids, callId: 'stale', tool: 'nia_group_chat_send_message', arguments: { content: 'No' } } });
  assert.equal((await waitResponse(log, 'stale')).result.success, false);
});

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
  for (const outcome of ['valid', 'tampered', 'canceled']) {
    test(`${method}: ${outcome} RS256 confirmation → correct decision`, async t => {
      const { f, log, emit, active } = await setup(t);
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
  const { f, host, log, emit, active } = await setup(t);
  const ids = await active();
  await emit({ id: 'pending', method: 'item/fileChange/requestApproval', params: { ...ids, itemId: 'file' } });
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
  await host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  assert.equal((await waitResponse(log, 'pending')).result.decision, 'decline');
  assert.deepEqual((await log()).find(m => m.method === 'turn/interrupt').params, ids);
  assert.ok(f.rpcs.some(r => r.method === 'card.cancel'));
  await emit(complete(ids, [{ type: 'agentMessage', id: 'stale', text: 'Do not publish' }]));
  assert.equal(f.rpcs.filter(r => r.method === 'group_chat.send_message').length, 0);
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
  await until(() => f.rpcs.some(r => r.method === 'group_chat.send_message'));
  assert.equal(f.rpcs.find(r => r.method === 'group_chat.send_message').params.sessionId, rotated.sessionId);
  assert.equal(f.rpcs.find(r => r.method === 'group_chat.send_message').params.content, 'From delta');
  await emit(complete({ threadId: 'codex-2', turnId: 'turn-2' }, [], { message: 'Model failed' }));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.errorMessage === 'Model failed'));
});

test('approval timeout declines; full-auto explicitly configures never and workspace-write', async t => {
  const { f, log, emit, active } = await setup(t, { approvalTimeoutMs: 40 });
  const ids = await active();
  await emit({ id: 'timeout', method: 'item/commandExecution/requestApproval', params: { ...ids, itemId: 'c', command: 'pwd' } });
  assert.equal((await waitResponse(log, 'timeout')).result.decision, 'decline');
  assert.ok(f.rpcs.some(r => r.method === 'card.cancel'));
});

test('full-auto bypass is explicit and sends accept without creating cards', async t => {
  const { f, log, emit, active } = await setup(t, { fullAuto: true });
  const ids = await active();
  const start = (await log()).find(m => m.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'workspace-write');
  await emit({ id: 'auto', method: 'item/commandExecution/requestApproval', params: { ...ids } });
  assert.equal((await waitResponse(log, 'auto')).result.decision, 'accept');
  assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
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

test('cancellation interrupts a turn blocked on final publication without stalling the thread lock', async t => {
  const { f, host, log, emit, active } = await setup(t);
  const ids = await active();
  f.holdRpc.add('group_chat.send_message');
  await emit(complete(ids, [{ type: 'agentMessage', id: 'a', text: 'Pending publication' }]));
  await until(() => f.rpcs.some(r => r.method === 'group_chat.send_message'));
  f.send({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  const end = Date.now() + 4000;
  while (!(await log()).some(m => m.method === 'turn/interrupt')) {
    if (Date.now() > end) throw new Error('Cancellation blocked behind publication');
    await new Promise(r => setTimeout(r, 5));
  }
  f.holdRpc.delete('group_chat.send_message');
  await host.message(message('hold next'));
  assert.equal((await log()).filter(m => m.method === 'turn/start').length, 2);
});

test('file approval preview comes from item lifecycle, and unknown server requests fail closed', async t => {
  const { f, log, emit, active } = await setup(t);
  const ids = await active();
  await emit({ method: 'item/started', params: { ...ids, item: { id: 'patch', type: 'fileChange', changes: [{ path: '/example.txt', diff: '+new content' }] } } });
  await emit({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { ...ids, itemId: 'patch', startedAtMs: Date.now() } });
  await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
  const card = f.rpcs.find(r => r.method === 'card.upsert');
  assert.match(card.params.description, /example.txt/); assert.match(card.params.description, /new content/);
  await emit({ id: 'unknown', method: 'item/unknown/requestApproval', params: ids });
  assert.equal((await waitResponse(log, 'unknown')).error.code, -32601);
});
