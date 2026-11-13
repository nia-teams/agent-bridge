import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { desktopCookies } from '../dist/desktop-auth.js';
import { cdpFixture, loadRunner } from './helpers.mjs';
const require = createRequire(import.meta.url);
async function setup(t, backend = 'work') {
  const fixture = await cdpFixture(t, backend);
  const dir = await mkdtemp(join(tmpdir(), 'nia-cookie-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = ['DOUBAO_CDP_ENDPOINT', 'DOUBAO_HEADLESS_COOKIE', 'NIA_MOCK_LOG', 'NIA_MOCK_CDP', 'NIA_MOCK_WAIT'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  delete process.env.NIA_MOCK_WAIT;
  process.env.DOUBAO_CDP_ENDPOINT = fixture.endpoint;
  process.env.NIA_MOCK_LOG = join(dir, 'calls.jsonl'); process.env.NIA_MOCK_CDP = 'ready';
  return { fixture, dir, calls: async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
for (const backend of ['work', 'doubao']) test(`${backend} uses only matching app target and Network.getAllCookies, filters cookie domains/expiry`, async t => {
  const { fixture } = await setup(t, backend);
  fixture.cookies = [
    { name: 'sessionid', value: 'local-session-secret', domain: '.doubao.com', expires: -1 },
    { name: 'sid_tt', value: 'also-valid', domain: 'www.doubao.com' },
    { name: 'other', value: 'valid', domain: 'doubao.com' },
    { name: 'sessionid', value: 'unrelated-cookie', domain: 'notdoubao.com' },
    { name: 'sneaky', value: 'unrelated-cookie', domain: 'doubao.com.evil.invalid' },
    { name: 'expired', value: 'expired', domain: '.doubao.com', expires: 1 },
    { name: 'newline', value: 'bad\r\n', domain: '.doubao.com' },
  ];
  assert.equal(await desktopCookies(backend), 'sessionid=local-session-secret; sid_tt=also-valid; other=valid');
  assert.deepEqual(fixture.requests, [{ id: 1, method: 'Network.getAllCookies' }]);
});
for (const kind of ['login', 'empty', 'wrongApp', 'wsError', 'httpError']) test(`desktop ${kind} fails safely without dumping cookies/response`, async t => {
  const { fixture } = await setup(t);
  if (kind === 'empty') fixture.cookies = [{ name: 'sessionid', value: '', domain: '.doubao.com' }]; else fixture[kind] = true;
  await assert.rejects(desktopCookies('work'), error => {
    assert.match(error.message, /Sign in|authenticated|Unable/);
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /secret-cookie-do-not-leak|test-cookie-one/);
    assert.equal(error.cause, undefined); return true;
  });
});
test('desktop cookies refresh at ready and each turn; only child env gets the new snapshot, never argv/logs', async t => {
  const { fixture, dir, calls } = await setup(t);
  process.env.DOUBAO_HEADLESS_COOKIE = 'sessionid=parent-must-not-change';
  const create = await loadRunner('darwin');
  const runner = create({ cwd: dir, platform: 'work' }); const sessions = [];
  const turn = resume => runner({ prompt: 'hello', resume, signal: new AbortController().signal, session: async id => sessions.push(id) });
  await runner.ready(); assert.equal(fixture.requests.length, 1);
  fixture.cookies[0].value = 'refreshed-secret-one';
  await turn(); assert.equal(fixture.requests.length, 2);
  fixture.cookies[0].value = 'refreshed-secret-two';
  await turn(sessions[0]); assert.equal(fixture.requests.length, 3);
  const tasks = (await calls()).filter(c => c.cookieHash);
  assert.equal(tasks.length, 2); assert.notEqual(tasks[0].cookieHash, tasks[1].cookieHash);
  assert.ok(tasks.every(c => c.args.includes('headless') && c.args.includes('--wait')));
  assert.ok(tasks[0].args.includes('--mode')); assert.equal(tasks[1].args.includes('--mode'), false);
  assert.match(sessions[0], /^work:/); assert.equal(sessions[1], sessions[0]);
  const logged = await readFile(join(dir, 'calls.jsonl'), 'utf8');
  assert.doesNotMatch(logged, /refreshed-secret|parent-must-not-change/);
  assert.equal(process.env.DOUBAO_HEADLESS_COOKIE, 'sessionid=parent-must-not-change');
});
test('logout/login target before next turn prevents submitting any task and is not masked by cached cookies', async t => {
  const { fixture, dir, calls } = await setup(t);
  const create = await loadRunner('darwin'); const runner = create({ cwd: dir, platform: 'work' }); await runner.ready();
  fixture.login = true;
  await assert.rejects(runner({ prompt: 'hi', signal: new AbortController().signal, session: async () => {} }), /Sign in inside DoubaoWork.app/);
  assert.equal((await calls()).some(c => c.args.includes('create')), false);
});
test('full-auto consent is programmatic per invocation; default never receives FullAccess', async t => {
  const { dir, calls } = await setup(t);
  const create = await loadRunner('darwin'); const context = { prompt: 'hi', signal: new AbortController().signal, session: async () => {} };
  await create({ cwd: dir, platform: 'work' })(context);
  await create({ cwd: dir, platform: 'work', fullAuto: true })(context);
  const tasks = (await calls()).filter(c => c.args.includes('create'));
  assert.equal(tasks[0].fullAccess, false); assert.ok(tasks[0].args.includes('AskOnRisk'));
  assert.equal(tasks[1].fullAccess, true); assert.ok(tasks[1].args.includes('FullAccess'));
});
test('REAL portable local executor: AskOnRisk reads files but denies Bash; FullAccess runs commands without terminal approval', async t => {
  const { dir } = await setup(t);
  const { HeadlessLocalRuntime } = await import(pathToFileURL(require.resolve('doubao-cli/src/headless-local-runtime.mjs')).href);
  await writeFile(join(dir, 'test.txt'), 'verified-file-read');
  const make = permission => new HeadlessLocalRuntime({ client: { request() {}, json() {} }, sandboxId: 'test', deviceId: '123456789', conversationId: '1234567890123456789', workspace: dir, permission, approve: async () => false });
  const restricted = make('AskOnRisk'), full = make('FullAccess');
  try {
    assert.match(JSON.stringify(await restricted.execute({ id: 'read', name: 'Read', input: { path: 'test.txt' } })), /verified-file-read/);
    assert.match(JSON.stringify(await restricted.execute({ id: 'bash', name: 'Bash', input: { command: 'printf verified-local-command' } })), /PERMISSION_DENIED/);
    assert.match(JSON.stringify(await full.execute({ id: 'bash', name: 'Bash', input: { command: 'printf verified-local-command' } })), /verified-local-command/);
  } finally { await restricted.close(); await full.close(); }
});

test('chrome-scheme app force-login target also blocks cookie reuse', async t => {
  const { fixture } = await setup(t);
  fixture.login = true; fixture.loginScheme = 'chrome';
  await assert.rejects(desktopCookies('work'), /Sign in inside DoubaoWork.app/);
  assert.equal(fixture.requests.length, 0);
});
