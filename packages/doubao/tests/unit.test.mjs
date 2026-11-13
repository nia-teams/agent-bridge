import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRunner, cdpFixture } from './helpers.mjs';
import { createRequire } from 'node:module';
import { resolveDoubaoPlatform, resolveDoubaoBinary, createDoubaoRunner } from '../dist/runner.js';
const binary = fileURLToPath(new URL('../../../tests/fixtures/mock-doubao.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const { parseOptions } = await import(pathToFileURL(require.resolve('doubao-cli/src/cli.mjs')).href);
const installed = (...paths) => path => paths.includes(path);

test('macOS prefers DoubaoWork, selects Doubao, respects explicit desktop selection, and fails clearly when absent', () => {
  const both = installed('/Applications/DoubaoWork.app', '/Applications/Doubao.app');
  assert.equal(resolveDoubaoPlatform(undefined, 'darwin', both), 'work');
  assert.equal(resolveDoubaoPlatform('doubao', 'darwin', both), 'doubao');
  assert.equal(resolveDoubaoPlatform(undefined, 'darwin', installed('/Applications/Doubao.app')), 'doubao');
  assert.equal(resolveDoubaoPlatform(undefined, 'darwin', installed()), 'cli');
  assert.equal(resolveDoubaoPlatform('auto', 'darwin', both, '/official/doubao'), 'cli');
  assert.throws(() => resolveDoubaoPlatform('work', 'darwin', installed('/Applications/Doubao.app')), /Install and sign in/);
  assert.equal(resolveDoubaoPlatform(undefined, 'linux', installed()), 'cli');
  assert.equal(resolveDoubaoPlatform('headless', 'darwin', installed()), 'headless');
  assert.throws(() => resolveDoubaoPlatform('work', 'linux', both), /requires macOS/);
});
test('default executable is the bundled unified driver, never PATH or @bytedance CLI', async () => {
  assert.match(resolveDoubaoBinary(), /doubao-cli\/bin\/doubao.mjs$/);
  assert.equal(JSON.parse(await readFile(require.resolve('doubao-cli/package.json'), 'utf8')).version, '0.23.3');
});
async function setup(t, os = 'darwin') {
  const dir = await mkdtemp(join(tmpdir(), 'nia-doubao-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = ['NIA_MOCK_LOG', 'NIA_MOCK_WAIT', 'NIA_MOCK_CDP', 'NIA_MOCK_NO_LOGIN', 'NIA_MOCK_STOP', 'DOUBAO_CDP_ENDPOINT'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.NIA_MOCK_LOG = join(dir, 'calls.jsonl');
  process.env.NIA_MOCK_CDP = 'ready';
  const cdp = os === 'darwin' ? await cdpFixture(t) : undefined;
  if (cdp) process.env.DOUBAO_CDP_ENDPOINT = cdp.endpoint;
  const create = await loadRunner(os);
  const make = options => create({ cwd: dir, platform: os === 'linux' ? 'headless' : 'auto', ...options });
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).args);
  const context = overrides => ({ prompt: 'hi --full-auto -literal', signal: new AbortController().signal, session: async () => {}, ...overrides });
  return { dir, make, calls, context, cdp };
}
test('desktop create then send persists receipt and returns reply.text without navigation; exact flags match real parser', async t => {
  const { dir, make, calls, context } = await setup(t);
  const runner = make(); const sessions = [];
  await Promise.all([runner.ready(), runner.ready()]);
  const result = await runner(context({ session: async id => sessions.push(id) }));
  assert.deepEqual(result, { text: 'Doubao final reply' });
  await runner(context({ resume: sessions[0] }));
  const records = await calls();
  assert.equal(records.filter(a => a.includes('cdp')).length, 1);
  assert.equal(records.filter(a => a.includes('models')).length, 0);
  const create = records.find(a => a.includes('create'));
  assert.equal(create[create.indexOf('--platform') + 1], 'headless');
  assert.equal(create[create.indexOf('--workspace') + 1], dir);
  assert.equal(create[create.indexOf('--runtime') + 1], 'local');
  assert.equal(create[create.indexOf('--permission') + 1], 'AskOnRisk');
  assert.equal(create.at(-1), 'hi --full-auto -literal');
  assert.ok(records.some(a => a.includes('send') && a.includes(sessions[0].split(':')[1])));
  for (const args of records) assert.doesNotThrow(() => parseOptions(args));
  assert.equal(records.some(a => a.includes('launch') || a.includes('open') || a.includes('login')), false);
});
test('Doubao.app explicit selection, model and full-auto map to local FullAccess using supported driver flags', async t => {
  const { make, calls, context, cdp } = await setup(t);
  const second = await cdpFixture(t, 'doubao'); process.env.DOUBAO_CDP_ENDPOINT = second.endpoint;
  await make({ platform: 'doubao', model: '豆包', fullAuto: true })(context());
  const args = (await calls()).find(a => a.includes('create'));
  assert.equal(args[args.indexOf('--platform') + 1], 'headless');
  assert.equal(args[args.indexOf('--permission') + 1], 'FullAccess');
  assert.equal(args[args.indexOf('--model') + 1], '豆包');
  assert.doesNotThrow(() => parseOptions(args));
});
for (const [state, restart, succeeds] of [['down', false, true], ['running', false, false], ['running', true, true], ['wrong', true, false]]) {
  test(`CDP startup ${state}, restart consent ${restart}`, async t => {
    const { make, calls } = await setup(t); process.env.NIA_MOCK_CDP = state;
    const runner = make({ restartApp: restart });
    if (succeeds) await runner.ready(); else await assert.rejects(runner.ready(), /restart-app|wrong CDP/);
    const launch = (await calls()).find(a => a.includes('launch'));
    if (state === 'wrong') assert.equal(launch, undefined);
    else { assert.ok(launch); assert.equal(launch.includes('--yes'), restart); }
  });
}
for (const os of ['darwin', 'linux']) test(`${os} unauthenticated startup gives sign-in instructions, never runs QR login`, async t => {
  const { make, calls, cdp } = await setup(t, os); process.env.NIA_MOCK_NO_LOGIN = '1'; if (cdp) cdp.login = true;
  await assert.rejects(make().ready(), /[Ss]ign.in/);
  assert.equal((await calls()).some(a => a.includes('login') || a.includes('create')), false);
});
test('headless default uses cloud; explicit local FullAccess is authorized programmatically', async t => {
  const { make, calls, context } = await setup(t, 'linux');
  await make()(context());
  const args = (await calls()).find(a => a.includes('create'));
  assert.equal(args[args.indexOf('--runtime') + 1], 'cloud');
  assert.equal(args.includes('--workspace'), false); assert.equal(args.includes('--permission'), false);
  await make({ runtime: 'local', fullAuto: true })(context());
});
test('abort during first submission still collects receipt and stops its exact run, no premature persistence', async t => {
  const { make, calls, context } = await setup(t);
  const runner = make(); await runner.ready(); const controller = new AbortController();
  let persisted = false;
  const turn = runner(context({ prompt: 'hold-submit', signal: controller.signal, session: async () => { persisted = true; } }));
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 80);
  await assert.rejects(turn, /cancelled/); clearTimeout(timer);
  const stopped = (await calls()).find(a => a.includes('stop'));
  assert.ok(stopped); assert.ok(stopped.includes('--run')); assert.equal(persisted, false);
});
for (const scenario of ['malformed', 'missing-receipt', 'authfail']) test(`submission ${scenario} is never resent or published`, async t => {
  const { make, calls, context } = await setup(t);
  await assert.rejects(make()(context({ prompt: scenario })), /no valid|sign-in/);
  assert.equal((await calls()).filter(a => a.includes('create')).length, 1);
});
for (const scenario of ['mismatch', 'empty', 'approval']) test(`wait ${scenario} refuses a false final`, async t => {
  const { make, calls, context } = await setup(t); process.env.NIA_MOCK_WAIT = scenario;
  await assert.rejects(make()(context()), /mismatched|without assistant|waiting_input/);
  if (scenario !== 'empty') assert.ok((await calls()).some(a => a.includes('stop')));
});
for (const stale of ['cli:old-native-uuid', 'doubao:1234567890123456789', 'headless:1234567890123456789', 'legacy-unprefixed']) test(`work ignores stale resume ${stale}`, async t => {
  const { make, context, calls } = await setup(t);
  let persisted;
  await make()(context({ resume: stale, session: async id => { persisted = id; } }));
  assert.match(persisted, /^work:\d{12,24}$/);
  assert.ok((await calls()).some(a => a.includes('create')));
  assert.equal((await calls()).some(a => a.includes('send')), false);
});
