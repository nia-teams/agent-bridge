import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiRunner } from '../dist/index.js';
import { agentThreadId, contract, message, sessionId, until } from '../../core/tests/helpers.mjs';
import { sessionIntegrationSetup } from '../../../tests/sdk-integration-suite.mjs';

const setup = sessionIntegrationSetup('Pi', options => createPiRunner({ configDir: options.cwd, ...options }), 'piBin', 'pi.approval', {
  executable: fileURLToPath(new URL('./mock-pi.mjs', import.meta.url)), model: 'mock-model', provider: 'mock-provider', thinking: 'high',
});
const idle = (f, frame) => f.rpcs.find(r => r.method === 'thread.activity' && r.params.deliveryId === frame.deliveryId && r.params.state === 'idle');
const entries = async f => (await readFile(join(f.dir, 'mock-pi.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const saved = async f => JSON.parse(await readFile(join(f.dir, 'threads.json'), 'utf8'))[agentThreadId].sessionId;
async function turn(f, content) {
  const frame = { ...message(content), prompt: content };
  f.send(frame);
  await until(() => idle(f, frame), `idle after ${content}`, 10000);
  return idle(f, frame).params;
}

test('Pi retains and resumes the GroupChat session, runs dynamic tools, and replaces only unavailable sessions', async t => {
  const { f, contexts, errors } = await setup(t);
  await turn(f, 'fresh');
  const original = await saved(f);
  const reminder = { ...message(), prompt: 'use tools' };
  f.send(reminder);
  await until(() => idle(f, reminder), 'reminder idle', 10000);
  assert.equal(contexts[1].resume, original);
  assert.equal(contexts[1].prompt, reminder.prompt);
  assert.equal(await saved(f), original);
  const toolCalls = f.rpcs.filter(r => r.method === 'tool.call');
  assert.deepEqual(toolCalls.map(r => [r.params.sessionId, r.params.name, r.params.arguments]), [
    [sessionId, 'chat_history', { limit: 2 }], [sessionId, 'send_message', { content: 'Pi interim' }],
  ]);
  assert.ok(f.rpcs.indexOf(toolCalls.at(-1)) < f.rpcs.indexOf(idle(f, reminder)));
  await unlink(original);
  await turn(f, 'missing fallback');
  const replacement = await saved(f);
  assert.notEqual(replacement, original);
  await writeFile(replacement, 'unloadable');
  await turn(f, 'unloadable fallback');
  assert.notEqual(await saved(f), replacement);
  const logs = await entries(f);
  const starts = logs.filter(e => e.type === 'start');
  assert.deepEqual(starts.map(e => e.flags['--session']), [undefined, original, undefined, replacement, undefined]);
  assert.equal(starts[0].systemPrompt, contract.systemPrompt);
  assert.equal(starts[0].flags['--model'], 'mock-model');
  assert.equal(starts[0].flags['--provider'], 'mock-provider');
  assert.equal(starts[0].flags['--thinking'], 'high');
  await assert.rejects(readFile(starts[0].flags['--append-system-prompt']), { code: 'ENOENT' });
  await assert.rejects(fetch(starts[0].endpoint));
  assert.equal(logs.filter(e => e.type === 'prompt').length, 4);
  assert.deepEqual(errors, []);
});

test('Pi handles early settlement, handled prompts, dialog cancellation and failure without replay', async t => {
  const { f, errors } = await setup(t);
  for (const prompt of ['fast', 'handled', 'dialogs']) assert.equal((await turn(f, prompt)).errorMessage, undefined);
  for (const [prompt, expected] of [['fail', /mock prompt rejected/], ['exit', /Pi RPC exited/], ['model error', /mock provider failed/], ['invalid disposition', /Invalid Pi RPC prompt disposition/]]) {
    assert.match((await turn(f, prompt)).errorMessage, expected);
  }
  const logs = await entries(f);
  assert.equal(logs.filter(e => e.type === 'dialog').length, 4);
  assert.equal(logs.filter(e => e.type === 'prompt').length, 7);
  assert.equal(errors.length, 4);
  assert.ok(!f.rpcs.some(r => r.method === 'card.upsert' || r.method === 'tool.call'));
});

for (const behavior of ['hold', 'hang']) test(`Pi sends abort and releases the turn (${behavior})`, async t => {
  const { f, host, errors } = await setup(t);
  const frame = { ...message(behavior), prompt: behavior };
  f.send(frame);
  await until(() => f.rpcs.some(r => r.params.label === 'Using mock_wait…'), 'Pi tool activity', 10000);
  host.cancel({ ...frame, type: 'thread.cancel', reason: 'user_aborted' });
  await turn(f, 'after cancel');
  const logged = (await entries(f)).filter(e => e.type === 'abort');
  assert.equal(logged.length, 1);
  assert.match(logged[0].id, /^[\da-f-]+$/);
  assert.deepEqual(errors, []);
});


test('new Pi RPC never treats an idle agent_end as settled', async t => {
  const { f, errors } = await setup(t);
  const result = await turn(f, 'modern delayed');
  assert.equal(result.errorMessage, undefined);
  assert.deepEqual(f.rpcs.filter(r => r.params.name === 'send_message').map(r => r.params.arguments.content), ['Pi settled only after follow-up']);
  assert.equal((await entries(f)).filter(e => e.type === 'state').length, 1, 'only startup needs get_state');
  assert.deepEqual(errors, []);
});

test('legacy Pi RPC drains busy state, retries and overflow compaction before reporting idle', async t => {
  const { f, errors } = await setup(t);
  for (const prompt of ['legacy delayed', 'legacy normal', 'legacy retry', 'legacy compaction']) {
    assert.equal((await turn(f, prompt)).errorMessage, undefined, prompt);
  }
  assert.match((await turn(f, 'legacy error')).errorMessage, /legacy provider failed/);
  const logs = await entries(f);
  assert.deepEqual(logs.filter(e => e.type === 'legacy drained').map(e => e.message), ['legacy delayed', 'legacy normal', 'legacy retry', 'legacy compaction', 'legacy error']);
  assert.ok(logs.some(e => e.type === 'state' && e.streaming));
  assert.ok(logs.some(e => e.type === 'state' && !e.streaming && e.queued));
  assert.deepEqual(f.rpcs.filter(r => r.params.name === 'send_message').map(r => r.params.arguments.content), ['Pi delayed run completed', 'Pi retry completed', 'Pi compaction recovery completed']);
  assert.equal(errors.length, 1);
});
