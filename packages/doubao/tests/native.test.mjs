import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeDoubaoBinary, resolveDoubaoBinary, resumeForBackend } from '../dist/index.js';
import { loadRunner, nativeBinary } from './helpers.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-native-doubao-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = ['NIA_MOCK_LOG', 'NIA_NATIVE_AUTH', 'NIA_NATIVE_AUTH_FILE', 'NIA_NATIVE_LOGIN', 'NIA_NATIVE_VERIFY'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.NIA_MOCK_LOG = join(dir, 'calls.jsonl');
  process.env.NIA_NATIVE_AUTH_FILE = join(dir, 'official-login-state');
  const spawns = [];
  const create = await loadRunner('darwin', true, spawns);
  const make = options => create({ cwd: dir, doubaoBin: nativeBinary, interactive: false, ...options });
  const records = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const calls = async () => (await records()).filter(x => x.args).map(x => x.args);
  const context = overrides => ({ prompt: 'hello', signal: new AbortController().signal, session: async () => {}, ...overrides });
  return { dir, make, calls, records, context, spawns };
}
for (const os of ['darwin', 'linux', 'win32']) test(`${os} auto native runtime is preferred over PATH, and explicit binary wins`, async t => {
  const { dir } = await setup(t);
  const data = join(dir, 'data');
  const expected = os === 'darwin' ? join(dir, 'Library/Application Support/doubao_cli/app/current/doubao')
    : os === 'win32' ? join(data, 'doubao_cli/app/current/doubao.exe') : join(data, 'doubao_cli/app/current/doubao');
  await mkdir(join(expected, '..'), { recursive: true }); await symlink(nativeBinary, expected);
  const env = { PATH: '', LOCALAPPDATA: data, XDG_DATA_HOME: data };
  assert.equal(await resolveNativeDoubaoBinary(undefined, { os, home: dir, env }, resolveDoubaoBinary()), nativeBinary);
  assert.equal(await resolveNativeDoubaoBinary(nativeBinary, { os, home: dir, env }, resolveDoubaoBinary()), nativeBinary);
});
test('PATH symlink to bundled CDP driver is excluded, official CLI on later PATH is selected', async t => {
  const { dir } = await setup(t);
  const first = join(dir, 'first'), second = join(dir, 'second');
  await mkdir(first); await mkdir(second);
  await symlink(resolveDoubaoBinary(), join(first, 'doubao'));
  await symlink(nativeBinary, join(second, 'doubao'));
  assert.equal(await resolveNativeDoubaoBinary(undefined, { os: 'linux', home: dir, env: { PATH: `${first}:${second}` } }, resolveDoubaoBinary()), nativeBinary);
  await assert.rejects(resolveNativeDoubaoBinary(undefined, { os: 'linux', home: dir, env: { PATH: first } }, resolveDoubaoBinary()), /Cannot find official/);
  await assert.rejects(resolveNativeDoubaoBinary(resolveDoubaoBinary(), undefined, resolveDoubaoBinary()), /Cannot find official/);
});
test('ready: authenticated CLI is verified once, no login even if interactive; auto explicit binary wins over desktop', async t => {
  const { make, calls } = await setup(t);
  const runner = make({ platform: 'auto', interactive: true });
  await Promise.all([runner.ready(), runner.ready()]);
  assert.deepEqual(await calls(), [['auth', 'status', '--verify']]);
});
test('ready: unauthenticated interactive terminal inherits all stdio, logs in, re-verifies, then continues', async t => {
  const { make, calls, context, spawns } = await setup(t);
  process.env.NIA_NATIVE_AUTH = 'missing';
  const runner = make({ interactive: true }); await runner.ready();
  assert.deepEqual(await calls(), [['auth', 'status', '--verify'], ['login'], ['auth', 'status', '--verify']]);
  assert.equal(spawns.find(x => x.args.at(-1) === 'login').options.stdio, 'inherit');
  assert.deepEqual(await runner(context()), { text: 'Doubao final reply' });
  assert.equal((await calls()).filter(a => a[0] === 'login').length, 1);
});
test('ready: unauthenticated non-TTY fails closed with terminal guidance, no login', async t => {
  const { make, calls } = await setup(t); process.env.NIA_NATIVE_AUTH = 'missing';
  await assert.rejects(make().ready(), /interactive local terminal.*doubao login/);
  assert.deepEqual(await calls(), [['auth', 'status', '--verify']]);
});
test('ready: default interactivity follows stdin AND stdout TTY (test process is noninteractive)', async t => {
  const { make, calls } = await setup(t); process.env.NIA_NATIVE_AUTH = 'missing';
  if (process.stdin.isTTY && process.stdout.isTTY) return t.skip('Requires non-TTY test runner');
  await assert.rejects(make({ interactive: undefined }).ready(), /interactive local terminal/);
  assert.equal((await calls()).some(a => a[0] === 'login'), false);
});
test('ready: failed local login does not start turn or reverify', async t => {
  const { make, calls } = await setup(t);
  process.env.NIA_NATIVE_AUTH = 'missing'; process.env.NIA_NATIVE_LOGIN = 'fail';
  await assert.rejects(make({ interactive: true }).ready(), /login failed or was cancelled/);
  assert.deepEqual(await calls(), [['auth', 'status', '--verify'], ['login']]);
});
test('ready: login exit 0 without verified saved session still fails closed', async t => {
  const { make, calls } = await setup(t);
  process.env.NIA_NATIVE_AUTH = 'missing'; process.env.NIA_NATIVE_VERIFY = 'fail';
  await assert.rejects(make({ interactive: true }).ready(), /still failed/);
  assert.deepEqual(await calls(), [['auth', 'status', '--verify'], ['login'], ['auth', 'status', '--verify']]);
});
test('native turn uses official arguments, stores cli prefix, resumes only matching namespace', async t => {
  const { make, calls, context, dir } = await setup(t); const sessions = [];
  const runner = make({ platform: 'cli', model: 'native-model' });
  const first = await runner(context({ prompt: 'hi --literal', session: async id => sessions.push(id) }));
  assert.deepEqual(first, { text: 'Doubao final reply' }); assert.match(sessions[0], /^cli:.+/);
  await runner(context({ resume: sessions[0] }));
  const turns = (await calls()).filter(a => a.includes('-p'));
  assert.deepEqual(turns[0], ['-C', dir, '--permission-mode', 'ask_always', '--model', 'native-model', '-p', 'hi --literal']);
  assert.equal(turns[1][turns[1].indexOf('--resume') + 1], sessions[0].slice(4));
});
for (const stale of ['work:1234567890123456789', 'doubao:1234567890123456789', 'headless:1234567890123456789', 'legacy-native-id']) test(`native ignores stale resume ${stale}`, async t => {
  const { make, calls, context } = await setup(t); let saved;
  await make()(context({ resume: stale, session: async id => { saved = id; } }));
  assert.match(saved, /^cli:/);
  assert.equal((await calls()).find(a => a.includes('-p')).includes('--resume'), false);
});
test('native full-auto selects always_allow; default approval fails closed and never resends', async t => {
  const { make, calls, context } = await setup(t);
  await assert.rejects(make()(context({ prompt: 'approval-needed' })), /User input is required/);
  assert.deepEqual(await make({ fullAuto: true })(context({ prompt: 'approval-needed' })), { text: 'Doubao final reply' });
  const turns = (await calls()).filter(a => a.includes('-p'));
  assert.equal(turns.length, 2); assert.ok(turns[1].includes('always_allow'));
});
test('native cancellation terminates the process group and never persists a stale final', async t => {
  const { make, calls, records, context } = await setup(t); const controller = new AbortController();
  const runner = make(); await runner.ready(); let persisted = false;
  const turn = runner(context({ prompt: 'hold', signal: controller.signal, session: async () => { persisted = true; } }));
  for (let i = 0; i < 200 && !(await calls()).some(a => a.includes('-p')); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 40)); controller.abort(new Error('native cancelled'));
  await assert.rejects(turn, /native cancelled/);
  assert.equal(persisted, false); assert.ok((await records()).some(x => x.signal === 'SIGTERM'));
});
for (const prompt of ['authfail', 'missing-marker']) test(`native ${prompt} refuses success without its contract`, async t => {
  const { make, context } = await setup(t);
  await assert.rejects(make()(context({ prompt })), /Login required|session marker/);
});
test('resume namespaces use an exact backend prefix, never cross-backend or legacy values', () => {
  for (const backend of ['cli', 'work', 'doubao', 'headless']) {
    assert.equal(resumeForBackend(`${backend}:raw`, backend), 'raw');
    assert.equal(resumeForBackend('raw', backend), undefined);
    assert.equal(resumeForBackend(`${backend}:`, backend), undefined);
    assert.equal(resumeForBackend('other:raw', backend), undefined);
  }
});
