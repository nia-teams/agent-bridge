import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { connectWithInvite, inviteRegistrationMessage, openBrowser, inviteDaemonArgs } from '../dist/index.js';

import { inviteFixture } from './invite-fixture.mjs';

test('invite signing fixture and first registration / credential reuse', async t => {
  assert.equal(inviteRegistrationMessage('I', 'U', 'A', 'N'), 'nia-agent-bridge-invite-v1\nI\nU\nA\nN');
  const f = await inviteFixture(t);
  const first = await connectWithInvite({ ...f.options, hostLabel: 'fixture-host', clientName: 'Fixture Client', avatar: 'fixture-avatar' });
  assert.equal(f.requests[0].body.hostLabel, 'fixture-host');
  assert.equal(f.requests[0].body.clientName, 'Fixture Client');
  assert.equal(f.requests[0].body.avatar, 'fixture-avatar');
  assert.equal(first.mode, 'paired'); assert.equal(first.browserOpened, false);
  assert.equal((await stat(join(f.dir, 'credentials.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  const before = await readFile(join(f.dir, 'credentials.json'), 'utf8');
  const second = await connectWithInvite({ ...f.options, userName: undefined, agentName: undefined });
  assert.equal(second.mode, 'reused'); assert.deepEqual(second.credentials, first.credentials);
  assert.deepEqual(f.requests.map(r => r.path), ['/api/agent-bridge/pairing/invite', '/api/agent-bridge/challenge', '/api/agent-bridge/invite-group-chat']);
  assert.equal(await readFile(join(f.dir, 'credentials.json'), 'utf8'), before);
  f.generation = 2; await assert.rejects(connectWithInvite(f.options), /generation changed/);
  f.status = 404; await assert.rejects(connectWithInvite(f.options), /challenge failed/);
  assert.equal(f.requests.filter(r => r.path.endsWith('/pairing/invite')).length, 1);
  await writeFile(join(f.dir, 'credentials.json'), '{}', { mode: 0o600 });
  await assert.rejects(connectWithInvite(f.options), /Invalid credentials/);
});
test('invalid input and missing names never register; explicit server change pairs', async t => {
  const f = await inviteFixture(t);
  for (const options of [{ inviteCode: '!bad' }, { userName: '' }, { agentName: 'x'.repeat(61) }]) await assert.rejects(connectWithInvite({ ...f.options, ...options }));
  assert.equal(f.requests.length, 0);
  await connectWithInvite(f.options);
  const other = await inviteFixture(t);
  assert.equal((await connectWithInvite({ ...other.options, configDir: f.dir })).mode, 'paired');
});
test('browser platform arguments, safe protocols and failure handling', async () => {
  const previous = process.env.NIA_NO_BROWSER; delete process.env.NIA_NO_BROWSER;
  try {
    for (const [platform, file, args] of [['darwin', 'open', ['https://nia-teams.com/?x=;bad']], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', 'https://nia-teams.com/?x=;bad']], ['linux', 'xdg-open', ['https://nia-teams.com/?x=;bad']]]) {
      const spawnImpl = (...actual) => {
        assert.deepEqual(actual, [file, args, { stdio: 'ignore', detached: true, ...(platform === 'win32' ? { windowsHide: true } : {}) }]);
        const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
      };
      assert.equal(await openBrowser(args.at(-1), { platform, spawnImpl }), true);
    }
    const fail = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; };
    assert.equal(await openBrowser('https://nia-teams.com', { spawnImpl: fail }), false);
    for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'not-url']) await assert.rejects(openBrowser(url));
    process.env.NIA_NO_BROWSER = '1';
    assert.equal(await openBrowser('https://nia-teams.com', { spawnImpl: () => { throw new Error('must not spawn'); } }), false);
  } finally { if (previous === undefined) delete process.env.NIA_NO_BROWSER; else process.env.NIA_NO_BROWSER = previous; }
});
test('daemon start arguments preserve runtime parameters without invite secrets', () => {
  assert.deepEqual(inviteDaemonArgs({ 'invite-code': 'SECRET', 'user-name': 'Alice', 'agent-name': 'Helper', 'no-browser': true, cwd: '/tmp/work', model: 'example', daemon: true, 'full-auto': true }), ['start', '--daemon', '--cwd', '/tmp/work', '--model', 'example', '--full-auto']);
});

for (const protocol of ['http:', 'https:']) test(`invite handoff validation for ${protocol} on registration and reuse, even without browser`, async t => {
  const f = await inviteFixture(t);
  // Keep transport local while exercising the configured HTTPS origin policy.
  const serverUrl = `${protocol}//bridge.example`;
  const fetchImpl = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(new URL(url).origin, serverUrl);
    return fetchImpl(new URL(new URL(url).pathname, f.url), init);
  });
  const options = { ...f.options, serverUrl };
  const invalid = ['not a URL', '/handoff', 'javascript:alert(1)', 'file:///tmp/handoff',
    'https://alice@public.example/handoff', 'https://:secret@public.example/handoff',
    'https://alice:secret@public.example/handoff'];
  if (protocol === 'https:') invalid.push('http://public.example/handoff');
  for (const url of invalid) {
    f.handoffUrl = url;
    await assert.rejects(connectWithInvite(options), /Invalid invite handoff URL/);
    await assert.rejects(stat(join(f.dir, 'credentials.json')), { code: 'ENOENT' });
  }
  // publicBaseUrl may differ from the request host, port, scheme and path.
  f.handoffUrl = 'https://public.example:8443/bridge/handoff?token=fixture#chat';
  const first = await connectWithInvite(options);
  assert.equal(first.mode, 'paired'); assert.equal(first.handoffUrl, f.handoffUrl);
  const credentials = await readFile(join(f.dir, 'credentials.json'), 'utf8');
  for (const url of invalid) {
    f.handoffUrl = url;
    await assert.rejects(connectWithInvite(options), /Invalid invite handoff URL/);
    assert.equal(await readFile(join(f.dir, 'credentials.json'), 'utf8'), credentials);
  }
  for (const url of ['https://public.example/handoff', ...(protocol === 'http:' ? ['http://another-public.example:8080/handoff'] : [])]) {
    f.handoffUrl = url;
    const reused = await connectWithInvite(options);
    assert.equal(reused.mode, 'reused'); assert.equal(reused.handoffUrl, url);
  }
});
