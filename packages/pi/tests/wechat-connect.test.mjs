import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { connectFixture, groupToken, pollSecret, startPath, statusPath, challengePath, joinPath } from '../../core/tests/connect-fixture.mjs';
const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/nia-pi.mjs', import.meta.url));
const cli = (...args) => exec(process.execPath, [entry, ...args]);
test('connect CLI prints the terminal QR, uses the default name and reuses credentials without QR', async t => {
  const f = await connectFixture(t);
  const common = ['connect', '--server-url', f.url, '--config-dir', f.dir, '--label', 'test-host', '--no-browser', '--no-start'];
  const first = await cli(...common, '--pi-bin', '/does/not/exist');
  assert.ok(first.stdout.includes('Agent: Pi (@external-helper)'));
  assert.match(first.stdout, /[█▀▄]/);
  assert.match(first.stdout, /Scan this QR code with WeChat:/);
  assert.ok(!first.stdout.includes(f.qrUrl));
  assert.match(first.stdout, /GroupChat: Local Chat \(group-fixture\)/);
  assert.ok(first.stdout.includes(`Handoff URL: ${f.defaultHandoffUrl}`));
  assert.ok(!first.stdout.includes(pollSecret));
  assert.doesNotMatch(first.stdout, /Started daemon/);
  const second = await cli(...common, '--group-link', `${f.url}/join/${groupToken}`);
  assert.doesNotMatch(second.stdout, /Scan this QR code with WeChat:|[█▀▄]/);
  assert.match(second.stdout, /GroupChat: Local Chat \(group-fixture\)/);
  assert.deepEqual(f.requests.map(r => r.path), [startPath, statusPath, challengePath, joinPath]);
  assert.equal(f.requests[0].body.hostLabel, 'test-host');
  assert.equal(f.requests[0].body.groupInviteToken, undefined);
  assert.equal(f.requests[3].body.groupInviteToken, groupToken);
});
test('connect checks unavailable host before creating an account', async t => {
  const f = await connectFixture(t);
  await assert.rejects(cli('connect', '--server-url', f.url, '--config-dir', f.dir, '--pi-bin', '/does/not/exist', '--no-browser'), /Cannot find pi at/);
  assert.equal(f.requests.length, 0);
});


test('connect keeps the paired Agent when the handoff URL is rejected', async t => {
  const f = await connectFixture(t);
  const common = ['--server-url', f.url, '--config-dir', f.dir, '--no-browser', '--no-start'];
  f.handoffUrl = 'https://invalid.example/handoff';
  await assert.rejects(cli('connect', ...common, '--agent-name', 'Local Helper'), /Invalid handoff URL/);
  assert.match((await cli('status', '--config-dir', f.dir)).stdout, /Agent: Local Helper \(@external-helper\)/);
  f.handoffUrl = undefined;
  const reused = await cli('connect', ...common);
  assert.doesNotMatch(reused.stdout, /Scan this QR code with WeChat:/);
  assert.deepEqual(f.requests.map(r => r.path), [startPath, statusPath, challengePath, joinPath]);
});
