import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, chmod, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pairWithNiaTeams, loadCredentials, stableExternalAgentThreadId } from '../dist/index.js';
import { fixture, teamId, groupChatId } from './helpers.mjs';
import { registrationMessage, challengeMessage } from '../dist/crypto.js';
const exec = promisify(execFile);

test('canonical signing strings and deterministic thread ID match byte fixtures', () => {
  assert.equal(registrationMessage('p', 't', 'n', 'u'), 'nia-agent-bridge-register-v1\np\nt\nn\nu');
  assert.equal(challengeMessage({ challengeId: 'c', teamId: 't', keyGeneration: 3, nonce: 'n' }), 'nia-agent-bridge-auth-v1\nc\nt\n3\nn');
  assert.equal(stableExternalAgentThreadId(groupChatId, teamId), 'nia-gc-QAI2QQC6IscVSfM-CAgtx_s5');
});
test('pair uses proof-of-possession, persists private key locally with 600/700 modes', async t => {
  const f = await fixture(t); let shown;
  const result = await pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir, hostLabel: 'my host', pollIntervalMs: 1, onPairing: info => { shown = info; } });
  assert.equal(shown.pairingCode, 'A1B2C3D4'); assert.match(shown.verificationUrl, /pair\?code=/);
  assert.equal(result.teamId, teamId); assert.equal(result.hostLabel, 'my host');
  assert.deepEqual(await loadCredentials(f.dir), result);
  assert.equal((await stat(`${f.dir}/credentials.json`)).mode & 0o777, 0o600);
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes('PRIVATE KEY')));
  await chmod(`${f.dir}/credentials.json`, 0o644);
  await assert.rejects(loadCredentials(f.dir), /private file/);
});
test('CLI pair and status exercise real HTTP routes without printing secrets', async t => {
  const f = await fixture(t);
  const paired = await exec(process.execPath, ['bin/nia-dsh.mjs', 'pair', '--server-url', f.url, '--config-dir', f.dir, '--label', 'cli test', '--timeout-ms', '5000']);
  assert.match(paired.stdout, /A1B2C3D4/); assert.match(paired.stdout, /Paired: Helper/); assert.doesNotMatch(paired.stdout, /PRIVATE KEY/);
  f.credentials = JSON.parse(await readFile(`${f.dir}/credentials.json`, 'utf8'));
  const status = await exec(process.execPath, ['bin/nia-dsh.mjs', 'status', '--config-dir', f.dir]);
  assert.match(status.stdout, /Challenge\/lease authentication: OK/); assert.doesNotMatch(status.stdout, /lease":|PRIVATE KEY/);
});
test('expired and timed-out pairing fail without replacing saved credentials', async t => {
  const f = await fixture(t); const before = await loadCredentials(f.dir);
  f.pairStatus = 'expired'; await assert.rejects(pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir }), /expired/);
  f.pairStatus = 'pending'; await assert.rejects(pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir, timeoutMs: 50, pollIntervalMs: 5 }));
  assert.deepEqual(await loadCredentials(f.dir), before);
});
