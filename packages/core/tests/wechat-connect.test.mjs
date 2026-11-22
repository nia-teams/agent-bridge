import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { connectWithWeChat, parseGroupInviteToken, connectRegistrationMessage, openBrowser, connectDaemonArgs } from '../dist/index.js';
import { connectFixture, groupToken, startPath, statusPath, challengePath, joinPath } from './connect-fixture.mjs';

test('canonical registration bytes retain nonce and token; no-token message ends in a newline', () => {
  const registration = { agentName: '聊天 助手', registrationNonce: ' nonce ' };
  assert.deepEqual(connectRegistrationMessage(registration), Buffer.from('nia-agent-bridge-connect-v1\n聊天 助手\n nonce \n', 'utf8'));
  assert.deepEqual(connectRegistrationMessage({ ...registration, groupInviteToken: ' t ' }), Buffer.from('nia-agent-bridge-connect-v1\n聊天 助手\n nonce \n t ', 'utf8'));
});

test('parse case-sensitive invite tokens and reject read-only share links', () => {
  assert.equal(parseGroupInviteToken(groupToken), groupToken);
  assert.equal(parseGroupInviteToken(`https://nia-teams.com/join/${groupToken.replace('.', '%2E')}?ref=example`), groupToken);
  assert.equal(parseGroupInviteToken(`/join/${groupToken}`), groupToken);
  for (const input of [`https://nia-teams.com/share/${groupToken}`, `/share/${groupToken}`]) {
    assert.throws(() => parseGroupInviteToken(input), /Read-only.*cannot be used to join a group/);
  }
  for (const input of ['', ` ${groupToken} `, 'bad', `ftp://niateams.example/join/${groupToken}`, '/join/%bad']) {
    assert.throws(() => parseGroupInviteToken(input), /Invalid --group-link/);
  }
});

test('pending scans do not persist credentials; approval does; reuse omits QR and supports no group link', async t => {
  const f = await connectFixture(t);
  f.pending = 1;
  const path = join(f.dir, 'credentials.json');
  const first = await connectWithWeChat({ ...f.options, groupLink: `${f.url}/join/${groupToken}`, hostLabel: 'fixture-host', clientName: 'Fixture Client', avatar: 'fixture-avatar', onScan: async info => {
    assert.deepEqual(info, { qrUrl: f.qrUrl, expiresInSeconds: 600 });
    assert.deepEqual(f.requests.map(r => r.path), [startPath]);
    await assert.rejects(stat(path), { code: 'ENOENT' });
  } });
  assert.equal(f.requests[0].body.hostLabel, 'fixture-host');
  assert.equal(f.requests[0].body.clientName, 'Fixture Client');
  assert.equal(f.requests[0].body.avatar, 'fixture-avatar');
  assert.equal(f.requests[0].body.groupInviteToken, groupToken);
  assert.equal(first.mode, 'paired'); assert.equal(first.browserOpened, false);
  assert.equal(first.groupChatTitle, 'Local Chat'); assert.equal(first.credentials.agentName, 'Local Helper');
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  }
  const before = await readFile(path, 'utf8');
  const second = await connectWithWeChat({ ...f.options, serverUrl: `${f.url}/`, agentName: undefined, onScan: () => assert.fail('must not scan') });
  assert.equal(second.mode, 'reused'); assert.deepEqual(second.credentials, first.credentials);
  assert.deepEqual(f.requests.map(r => r.path), [startPath, statusPath, statusPath, challengePath, joinPath]);
  assert.equal(f.requests.at(-1).body.groupInviteToken, undefined);
  f.generation = 2; await assert.rejects(connectWithWeChat(f.options), /generation changed/);
  f.generation = 1; f.challengeStatus = 404; await assert.rejects(connectWithWeChat(f.options), /challenge failed/);
  f.challengeStatus = 200; f.joinStatus = 403; await assert.rejects(connectWithWeChat(f.options), /Existing Agent could not connect/);
  assert.equal(f.requests.filter(r => r.path === startPath).length, 1);
  assert.equal(await readFile(path, 'utf8'), before);
  await writeFile(path, '{}', { mode: 0o600 });
  await assert.rejects(connectWithWeChat(f.options), /Invalid credentials/);
});

test('invalid input, start error, expiry, timeout, and poll denial never install credentials', async t => {
  const f = await connectFixture(t);
  const options = { ...f.options, onScan: () => assert.fail('must not scan') };
  await assert.rejects(connectWithWeChat({ ...options, groupLink: 'bad' }), /Invalid --group-link/);
  await assert.rejects(connectWithWeChat({ ...options, agentName: '' }), /1–60 characters/);
  assert.equal(f.requests.length, 0);
  f.startStatus = 404; await assert.rejects(connectWithWeChat({ ...options, groupLink: groupToken }), /Group invite is invalid/);
  for (const status of [403, 409, 429]) {
    f.startStatus = status; await assert.rejects(connectWithWeChat(options), new RegExp(`start returned HTTP ${status}`));
  }
  f.startStatus = 200;
  f.expired = true; await assert.rejects(connectWithWeChat(f.options), /QR code expired/);
  f.expired = false; f.pollStatus = 403; await assert.rejects(connectWithWeChat(f.options), /status returned HTTP 403/);
  f.pollStatus = 200; f.pending = 100;
  await assert.rejects(connectWithWeChat({ ...f.options, timeoutMs: 20, pollIntervalMs: 100 }), /QR code expired/);
  await assert.rejects(stat(join(f.dir, 'credentials.json')), { code: 'ENOENT' });
});

test('an explicitly different server uses registration', async t => {
  const first = await connectFixture(t); const other = await connectFixture(t);
  await connectWithWeChat(first.options);
  assert.equal((await connectWithWeChat({ ...other.options, configDir: first.dir })).mode, 'paired');
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
test('first-time and reused connections open only the handoff URL', async t => {
  const f = await connectFixture(t);
  const opener = `
    import { EventEmitter } from 'node:events';
    import { existsSync } from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const options = ${JSON.stringify(f.options)};
    const path = ${JSON.stringify(join(f.dir, 'credentials.json'))};
    const calls = [];
    createRequire(import.meta.url)('node:child_process').spawn = (_command, args) => {
      calls.push({ url: args.at(-1), saved: existsSync(path) });
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    syncBuiltinESMExports();
    const { connectWithWeChat } = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const first = await connectWithWeChat({ ...options, openBrowser: true, onScan: () => {
      if (calls.length) throw new Error('Browser opened during QR setup');
    } });
    const second = await connectWithWeChat({ ...options, openBrowser: true });
    process.env.NIA_NO_BROWSER = '1';
    const suppressed = await connectWithWeChat({ ...options, openBrowser: true });
    const noBrowser = await connectWithWeChat({ ...options, openBrowser: false });
    console.log(JSON.stringify({ calls, opened: [first.browserOpened, second.browserOpened, suppressed.browserOpened, noBrowser.browserOpened] }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', opener], { env: { ...process.env, NIA_NO_BROWSER: '0' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  assert.equal((await once(child, 'close'))[0], 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { opened: [true, true, false, false], calls: [
    { url: f.defaultHandoffUrl, saved: true }, { url: f.defaultHandoffUrl, saved: true },
  ] });
});

test('daemon start arguments preserve runtime parameters without connection-only values', () => {
  assert.deepEqual(connectDaemonArgs({ 'group-link': 'SECRET', 'agent-name': 'Helper', 'no-browser': true, cwd: '/tmp/work', model: 'example', daemon: true, 'full-auto': true }), ['start', '--daemon', '--cwd', '/tmp/work', '--model', 'example', '--full-auto']);
});

for (const protocol of ['http:', 'https:']) test(`connect requires the ${protocol} bridge origin and exact handoff path, even without browser`, async t => {
  const f = await connectFixture(t);
  // Keep transport local while exercising both configured origin schemes.
  const serverUrl = `${protocol}//bridge.example`;
  const otherOrigin = `${protocol}//unrelated.example`;
  const otherScheme = `${protocol === 'http:' ? 'https:' : 'http:'}//bridge.example`;
  const fetchImpl = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, serverUrl);
    return fetchImpl(new URL(parsed.pathname + parsed.search, f.url), init);
  });
  const options = { ...f.options, serverUrl };
  const path = join(f.dir, 'credentials.json');
  const handoff = '/api/agent-bridge/handoff?code=fixture';
  const invalidHandoffs = ['not a URL', handoff, 'javascript:alert(1)', `file://${handoff}`,
    `${protocol}//alice:secret@bridge.example${handoff}`, `${otherOrigin}${handoff}`, `${otherScheme}${handoff}`,
    `${serverUrl}:8443${handoff}`, `${serverUrl}/handoff?code=fixture`, `${serverUrl}/api/agent-bridge/handoff/`];
  for (const url of invalidHandoffs) {
    f.handoffUrl = url;
    await assert.rejects(connectWithWeChat(options), /Invalid handoff URL/);
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  f.handoffUrl = `${serverUrl}${handoff}`;
  const first = await connectWithWeChat({ ...options, onScan: info => {
    // The terminal QR payload may use a different WeChat provider origin.
    assert.equal(info.qrUrl, f.qrUrl);
  } });
  assert.equal(first.mode, 'paired'); assert.equal(first.handoffUrl, f.handoffUrl);
  const credentials = await readFile(path, 'utf8');
  for (const url of invalidHandoffs) {
    f.handoffUrl = url;
    await assert.rejects(connectWithWeChat(options), /Invalid handoff URL/);
    assert.equal(await readFile(path, 'utf8'), credentials);
  }
  f.handoffUrl = `${serverUrl}${handoff}`;
  const reused = await connectWithWeChat(options);
  assert.equal(reused.mode, 'reused'); assert.equal(reused.handoffUrl, f.handoffUrl);
});
