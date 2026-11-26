import { approvalCliSuite } from '../../../tests/approval-cli-suite.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectFixture, groupToken, pollSecret, startPath, statusPath, challengePath, joinPath } from '../../core/tests/connect-fixture.mjs';
import { fixture } from '../../core/tests/helpers.mjs';
const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/nia-workbuddy.mjs', import.meta.url));
approvalCliSuite(entry);
function cli(args, model) {
  const env = { ...process.env };
  if (model === undefined) delete env.CODEBUDDY_MODEL;
  else env.CODEBUDDY_MODEL = model;
  return exec(process.execPath, [entry, ...args], { env, timeout: 10_000 });
}
const hint = /--model <model-id> or set CODEBUDDY_MODEL/;

test('connect --no-start prints the QR and reuses credentials without a model', async t => {
  const f = await connectFixture(t);
  const common = ['connect', '--server-url', f.url, '--config-dir', f.dir, '--label', 'test-host', '--no-browser', '--no-start'];
  const first = await cli([...common, '--require-approval']);
  assert.ok(first.stdout.includes('Agent: WorkBuddy (@external-helper)'));
  assert.match(first.stdout, /[█▀▄]/);
  assert.match(first.stdout, /Scan this QR code with WeChat:/);
  assert.ok(!first.stdout.includes(f.qrUrl));
  assert.match(first.stdout, /GroupChat: Local Chat \(group-fixture\)/);
  assert.ok(first.stdout.includes(`Handoff URL: ${f.defaultHandoffUrl}`));
  assert.ok(!first.stdout.includes(pollSecret));
  assert.doesNotMatch(first.stdout, /Started daemon/);
  const second = await cli([...common, '--full-auto', '--group-link', `${f.url}/join/${groupToken}`], 'auto');
  assert.doesNotMatch(second.stdout, /Scan this QR code with WeChat:|[█▀▄]/);
  assert.match(second.stdout, /GroupChat: Local Chat \(group-fixture\)/);
  assert.deepEqual(f.requests.map(r => r.path), [startPath, statusPath, challengePath, joinPath]);
  assert.equal(f.requests[0].body.hostLabel, 'test-host');
  assert.equal(f.requests[0].body.groupInviteToken, undefined);
  assert.equal(f.requests[3].body.groupInviteToken, groupToken);
});
test('start and connect autostart reject missing and Auto models before side effects', async t => {
  const f = await connectFixture(t);
  const start = ['start', '--daemon', '--config-dir', f.dir];
  const connect = ['connect', '--server-url', f.url, '--config-dir', f.dir, '--no-browser'];
  for (const args of [start, connect]) {
    await assert.rejects(cli(args), { code: 1, stderr: /Auto routing.*loop on MCP tool calls.*--model <model-id> or set CODEBUDDY_MODEL.*glm-5\.3/ });
    await assert.rejects(cli([...args, '--model', ' AuTo-ChAt '], 'glm-5.3'), { code: 1, stderr: /uses Auto routing/ });
    await assert.rejects(cli(args, ' balanced-model '), { code: 1, stderr: /uses Auto routing/ });
    await assert.rejects(cli([...args, '--model', '   '], 'glm-5.3'), { code: 1, stderr: hint });
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(access(join(f.dir, 'daemon.log')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.dir, 'credentials.json')), { code: 'ENOENT' });
});
test('an explicit model overrides the environment, and the environment can supply the model', async t => {
  const f = await connectFixture(t);
  const missing = join(f.dir, 'missing.mjs');
  const start = ['start', '--config-dir', f.dir, '--codebuddy-bin', missing];
  const connect = ['connect', '--server-url', f.url, '--config-dir', f.dir, '--codebuddy-bin', missing, '--no-browser'];
  for (const args of [start, connect]) {
    // Reaching binary discovery proves model preflight succeeded.
    await assert.rejects(cli([...args, '--model', 'glm-5.3'], 'auto'), { code: 1, stderr: /missing\.mjs/ });
    await assert.rejects(cli(args, ' kimi-k2.6 '), { code: 1, stderr: /missing\.mjs/ });
  }
  assert.equal(f.requests.length, 0);
});
test('start --daemon rejects a missing binary before creating daemon files', async t => {
  const f = await connectFixture(t);
  const binary = join(f.dir, 'missing-codebuddy.exe');
  await assert.rejects(cli(['start', '--daemon', '--config-dir', f.dir, '--codebuddy-bin', binary], 'glm-5.3'), {
    code: 1, stdout: '', stderr: /Cannot find codebuddy.*missing-codebuddy\.exe/,
  });
  await assert.rejects(access(join(f.dir, 'daemon.log')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.dir, 'daemon.pid')), { code: 'ENOENT' });
});

test('stop is idempotent and does not require a model', async t => {
  const f = await connectFixture(t);
  assert.match((await cli(['stop', '--config-dir', f.dir])).stdout, /No WorkBuddy daemon is running/);
});

test('pair, status and help do not require a model', async t => {
  const f = await fixture(t);
  f.pendingPolls = 0;
  const config = ['--config-dir', f.dir];
  assert.match((await cli(['pair', '--server-url', f.url, ...config])).stdout, /Paired: Helper/);
  assert.match((await cli(['status', ...config])).stdout, /Agent: Helper/);
  const { stdout } = await cli(['--help']);
  assert.match(stdout, /^nia-workbuddy connect .*--model/m);
  assert.match(stdout, /^nia-workbuddy start .*--model/m);
  assert.match(stdout, /^nia-workbuddy stop /m);
});
