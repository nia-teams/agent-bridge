import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BridgeClient, SessionHost, stableExternalAgentThreadId } from '@nia-teams/agent-bridge-core';
import { fixture, message, until, agentThreadId, sessionId, teamId } from '../packages/core/tests/helpers.mjs';
const binary = fileURLToPath(new URL('./fixtures/mock-sdk-cli.mjs', import.meta.url));
export function sdkIntegrationSuite(runtime, createRunner, binKey, approvalTool) {
  async function setup(t, extra = {}) {
    const f = await fixture(t), errors = [];
    const bridge = new BridgeClient(f.credentials, { rpcTimeoutMs: 300, reconnectBaseMs: 10 });
    const host = new SessionHost(bridge, createRunner({ cwd: f.dir, [binKey]: binary, ...extra }), { configDir: f.dir, runtime, approvalTool, approvalTimeoutMs: 2000, onError: e => errors.push(e), ...extra });
    await host.start(); await bridge.start(); t.after(async () => { await host.close(); bridge.close(); });
    return { f, host, errors };
  }
  const sends = f => f.rpcs.filter(r => r.method === 'group_chat.send_message');
  test(`${runtime}: real SDK initialize, query, result publication and durable resume`, async t => {
    const { f, host, errors } = await setup(t); host.message(message('hello'));
    await until(() => sends(f).length === 1, 'first final', 10000);
    await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
    const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'));
    assert.ok(saved[agentThreadId].sessionId);
    host.message(message('second'));
    await until(() => sends(f).length === 2, 'second final', 10000);
    assert.equal(JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId, saved[agentThreadId].sessionId);
    assert.deepEqual(sends(f).map(r => r.params.content), ['SDK final reply', 'SDK final reply']);
    assert.deepEqual(errors, []);
  });
  test(`${runtime}: real in-process MCP history/send tool routing and no duplicate natural final`, async t => {
    const { f, host, errors } = await setup(t); host.message(message('use tools'));
    await until(() => sends(f).length === 1, 'MCP publication', 10000);
    await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'), 'MCP idle', 10000);
    assert.equal(sends(f)[0].params.content, 'SDK interim');
    assert.equal(f.rpcs.find(r => r.method === 'group_chat.history').params.sessionId, sessionId);
    assert.deepEqual(errors, []);
  });
  for (const outcome of ['approved', 'tampered', 'canceled']) test(`${runtime}: canUseTool → signed TaskBar ${outcome}`, async t => {
    const { f, host, errors } = await setup(t); host.message(message('permission'));
    await until(() => f.rpcs.some(r => r.method === 'card.upsert'), 'permission card', 10000);
    const card = f.rpcs.find(r => r.method === 'card.upsert');
    assert.equal(card.params.verifyToolName, approvalTool);
    await f.confirm(card, { tamper: outcome === 'tampered', decision: outcome === 'canceled' ? 'canceled' : 'approved' });
    await until(() => sends(f).length === 1, 'permission result', 10000);
    assert.ok(f.rpcs.some(r => r.method === 'card.cancel'));
    assert.equal(errors.length > 0, outcome === 'tampered');
  });
  test(`${runtime}: cancel aborts SDK query and pending approval without publishing final`, async t => {
    const { f, host } = await setup(t); host.message(message('permission'));
    await until(() => f.rpcs.some(r => r.method === 'card.upsert'), 'pending card', 10000);
    host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
    await until(() => f.rpcs.some(r => r.method === 'card.cancel'));
    host.message(message('next'));
    await until(() => sends(f).length === 1, 'next turn', 10000);
    assert.equal(sends(f)[0].params.content, 'SDK final reply');
  });
  test(`${runtime}: AskUserQuestion waits for invoking human's GroupChat answer`, async t => {
    const { f, host } = await setup(t); host.message(message('question'));
    await until(() => sends(f).length === 1, 'question published', 10000);
    assert.match(sends(f)[0].params.content, /Choose a color/);
    assert.ok(f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'waiting'));
    host.message(message('Blue'));
    await until(() => sends(f).length === 2, 'answered final', 10000);
    assert.equal(sends(f)[1].params.content, 'SDK final reply');
    assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  });
  test(`${runtime}: new GroupChat gets separate session, rotated Nia session cancels old query`, async t => {
    const { f, host } = await setup(t); host.message(message('hold'));
    await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'executing'));
    host.message({ ...message('new turn'), sessionId: 'abcdefabcdefabcdefabcdef' });
    await until(() => sends(f).length === 1, 'rotated turn final', 10000);
    assert.equal(sends(f)[0].params.sessionId, 'abcdefabcdefabcdefabcdef');
    const group = 'abcdef123456abcdef123456';
    host.message({ ...message('other group'), groupChatId: group, agentThreadId: stableExternalAgentThreadId(group, teamId) });
    await until(() => sends(f).length === 2, 'other chat final', 10000);
    const saved = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'));
    assert.equal(Object.keys(saved).length, 2); assert.notEqual(...Object.values(saved).map(v => v.sessionId));
  });
}
