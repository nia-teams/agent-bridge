import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeClient, SessionHost } from '@nia-teams/agent-bridge-core';
import { loadRunner } from './helpers.mjs';
import { fixture, message, until, agentThreadId } from '../../core/tests/helpers.mjs';
const binary = fileURLToPath(new URL('../../../tests/fixtures/mock-doubao.mjs', import.meta.url));
async function setup(t, extra = {}) {
  const f = await fixture(t), errors = [];
  const keys = ['NIA_MOCK_LOG', 'NIA_MOCK_WAIT', 'NIA_MOCK_STOP'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.NIA_MOCK_LOG = join(f.dir, 'driver.jsonl');
  delete process.env.NIA_MOCK_WAIT; delete process.env.NIA_MOCK_STOP;
  const createDoubaoRunner = await loadRunner('linux');
  const bridge = new BridgeClient(f.credentials);
  const host = new SessionHost(bridge, createDoubaoRunner({ cwd: f.dir, platform: 'headless', ...extra }), { configDir: f.dir, runtime: 'Doubao', approvalTool: 'doubao.approval', onError: e => errors.push(e) });
  await host.start(); await bridge.start();
  t.after(async () => { await host.close(); bridge.close(); });
  const records = async () => (await readFile(join(f.dir, 'driver.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).args);
  return { f, host, errors, records };
}
const sends = f => f.rpcs.filter(r => r.method === 'group_chat.send_message');
test('Doubao JSON receipt, clean assistant reply, durable conversation resume and startup only once', async t => {
  const { f, host, errors, records } = await setup(t);
  host.message(message('hello'));
  await until(() => sends(f).length === 1, 'first reply', 10000);
  const first = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId;
  host.message(message('again'));
  await until(() => sends(f).length === 2, 'second reply', 10000);
  assert.equal(JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId].sessionId, first);
  assert.deepEqual(sends(f).map(r => r.params.content), ['Doubao final reply', 'Doubao final reply']);
  assert.deepEqual(errors, []);
  const calls = await records();
  assert.equal(calls.filter(a => a.includes('status')).length, 1);
  assert.equal(calls.filter(a => a.includes('create')).length, 1);
  assert.ok(calls.some(a => a.includes('send') && a.includes(first.split(':')[1])));
  assert.ok(calls.filter(a => a.includes('--wait')).every(a => !a.includes('--run')));
  assert.equal(calls.some(a => a.includes('open') || a.includes('login') || a.includes('-p')), false);
});
test('Doubao cancellation stops the pinned accepted remote run, suppresses stale final, then resumes', async t => {
  const { f, host, records } = await setup(t);
  process.env.NIA_MOCK_WAIT = 'hold';
  host.message(message('hold'));
  // Session persistence precedes the cancellable wait command.
  let first;
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'executing'), 'executing');
  for (let i = 0; i < 200; i++) {
    try { first = JSON.parse(await readFile(`${f.dir}/threads.json`, 'utf8'))[agentThreadId]?.sessionId; if (first && (await records()).some(a => a.includes('--wait'))) break; } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(first);
  host.cancel({ ...message(), type: 'thread.cancel', reason: 'user_aborted' });
  delete process.env.NIA_MOCK_WAIT;
  host.message(message('next'));
  await until(() => sends(f).length === 1, 'recovery final', 10000);
  const calls = await records();
  const stopped = calls.find(a => a.includes('stop'));
  assert.ok(stopped.includes(first.split(':')[1])); assert.ok(stopped.includes('--run'));
  assert.equal(sends(f)[0].params.content, 'Doubao final reply');
});
test('Doubao auth failures surface once without resend or GroupChat publication', async t => {
  const { f, host, errors, records } = await setup(t);
  host.message(message('authfail'));
  await until(() => errors.length > 0, 'auth failure', 10000);
  assert.match(errors[0].message, /sign-in/); assert.equal(sends(f).length, 0);
  assert.equal((await records()).filter(a => a.includes('create')).length, 1);
});
test('Doubao pending native approval fails closed and stops the live task, no pretend TaskBar approval', async t => {
  const { f, host, errors, records } = await setup(t);
  process.env.NIA_MOCK_WAIT = 'approval';
  host.message(message('approval-needed'));
  await until(() => errors.length > 0, 'native approval', 10000);
  assert.equal(sends(f).length, 0); assert.equal(f.rpcs.filter(r => r.method === 'card.upsert').length, 0);
  assert.ok((await records()).some(a => a.includes('stop')));
});
