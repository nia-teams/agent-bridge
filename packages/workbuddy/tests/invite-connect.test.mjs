import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { inviteFixture } from '../../core/tests/invite-fixture.mjs';
const exec = promisify(execFile);
const entry = new URL('../bin/nia-workbuddy.mjs', import.meta.url);
test('connect CLI pairs in foreground and reuses credentials without names', async t => {
  const f = await inviteFixture(t);
  const common = ['connect', '--invite-code', ' ab_cd-12 ', '--server-url', f.url, '--config-dir', f.dir, '--no-browser', '--no-start'];
  const first = await exec(process.execPath, [entry.pathname, ...common, '--user-name', 'Alice Example', '--agent-name', 'Local Helper']);
  assert.match(first.stdout, /Agent: Local Helper \(@external-helper\)/);
  assert.match(first.stdout, /GroupChat: group-fixture/);
  assert.ok(first.stdout.includes(`Handoff URL: ${f.url}/handoff`));
  const second = await exec(process.execPath, [entry.pathname, ...common]);
  assert.match(second.stdout, /GroupChat: group-fixture/);
  assert.deepEqual(f.requests.map(r => r.path), ['/api/agent-bridge/pairing/invite', '/api/agent-bridge/challenge', '/api/agent-bridge/invite-group-chat']);
});
test('connect checks unavailable host before creating an account', async t => {
  const f = await inviteFixture(t);
  await assert.rejects(exec(process.execPath, [entry.pathname, 'connect', '--invite-code', 'AB_CD-12', '--user-name', 'Alice Example', '--agent-name', 'Local Helper', '--server-url', f.url, '--config-dir', f.dir, '--codebuddy-bin', '/does/not/exist', '--no-browser']));
  assert.equal(f.requests.length, 0);
});
