import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { access, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stopSessionDaemon } from '../dist/index.js';
import { fixture, message, until } from './helpers.mjs';

function nodeChild(t, source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, closed, stderr: () => stderr };
}

function runDaemon(t, f, afterShutdown = '') {
  return nodeChild(t, `import { runSessionDaemon } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    await runSessionDaemon(async () => { throw new Error('test runtime failure'); }, { configDir: ${JSON.stringify(f.dir)}, runtime: 'Test', approvalTool: 'test' });
    ${afterShutdown}`);
}

async function waitForPid(path, pid) {
  await until(() => {
    try { return JSON.parse(readFileSync(path, 'utf8')).pid === pid; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }, 'daemon PID registration', 8000);
  return JSON.parse(await readFile(path, 'utf8'));
}

test('daemon registers a private PID record, logs ISO timestamps, and clears the record on stop', async t => {
  const f = await fixture(t);
  const pidFile = join(f.dir, 'daemon.pid');
  assert.equal(await stopSessionDaemon(join(f.dir, 'missing')), undefined);
  assert.equal(await stopSessionDaemon(f.dir), undefined);
  const { child, closed, stderr } = runDaemon(t, f);
  const record = await waitForPid(pidFile, child.pid);
  assert.match(record.token, /^[a-f\d-]{36}$/);
  assert.match(record.identity, /^[a-f\d]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(pidFile)).mode & 0o777, 0o600);
  f.send(message());
  await until(() => f.rpcs.some(rpc => rpc.params.errorMessage === 'test runtime failure'));
  assert.equal(await stopSessionDaemon(f.dir), child.pid);
  const [code, signal] = await closed;
  if (process.platform !== 'win32') assert.deepEqual([code, signal], [0, null]);
  assert.match(stderr(), /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] test runtime failure$/m);
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
  await writeFile(pidFile, JSON.stringify(record), { mode: 0o600 });
  assert.equal(await stopSessionDaemon(f.dir), undefined);
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
  await writeFile(pidFile, '-1\n', { mode: 0o600 });
  await assert.rejects(stopSessionDaemon(f.dir), /Invalid daemon\.pid record/);
});

test('stop waits for process exit after the daemon removes its PID file', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'daemon.pid');
  const { child, closed } = runDaemon(t, f, 'await new Promise(resolve => setTimeout(resolve, 800));');
  await waitForPid(path, child.pid);
  const stopped = stopSessionDaemon(f.dir);
  await until(() => !existsSync(path), 'PID file cleanup');
  assert.equal(process.kill(child.pid, 0), true);
  assert.equal(await stopped, child.pid);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await closed, [0, null]);
});

test('a superseded daemon reports 4409 without deleting the replacement PID record', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'daemon.pid');
  const old = runDaemon(t, f);
  const first = await waitForPid(path, old.child.pid);
  const oldSocket = f.socket;
  const replacement = runDaemon(t, f);
  const next = await waitForPid(path, replacement.child.pid);
  assert.notEqual(next.token, first.token);
  oldSocket.close(4409, 'test replacement');
  assert.deepEqual(await old.closed, [1, null]);
  assert.match(old.stderr(), /superseded \(4409/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
  assert.equal(await stopSessionDaemon(f.dir), replacement.child.pid);
  await replacement.closed;
});

test('stop removes a stale record for an unrelated live Node process without signaling it', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'daemon.pid');
  const daemon = runDaemon(t, f);
  const record = await waitForPid(path, daemon.child.pid);
  assert.equal(await stopSessionDaemon(f.dir), daemon.child.pid);
  await daemon.closed;
  const unrelated = nodeChild(t, 'setInterval(() => {}, 1000);');
  await once(unrelated.child, 'spawn');
  await writeFile(path, JSON.stringify({ ...record, pid: unrelated.child.pid }), { mode: 0o600 });
  assert.equal(await stopSessionDaemon(f.dir), undefined);
  assert.equal(process.kill(unrelated.child.pid, 0), true);
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('cleanup leaves a newer registration even when the PID is identical', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'daemon.pid');
  const daemon = runDaemon(t, f);
  const record = await waitForPid(path, daemon.child.pid);
  const next = { ...record, token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  await writeFile(path, JSON.stringify(next), { mode: 0o600 });
  f.socket.close(4409, 'test same PID');
  assert.deepEqual(await daemon.closed, [1, null]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
});

test('stop reports a timeout if the daemon stays alive after releasing its PID file', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'daemon.pid');
  const { child } = runDaemon(t, f, 'setInterval(() => {}, 1000);');
  await waitForPid(path, child.pid);
  await assert.rejects(stopSessionDaemon(f.dir), /did not stop within 5 seconds/);
  assert.equal(existsSync(path), false);
  assert.equal(process.kill(child.pid, 0), true);
});

test('stop rejects a symlink PID file without touching its target', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const target = join(f.dir, 'target');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, join(f.dir, 'daemon.pid'));
  await assert.rejects(stopSessionDaemon(f.dir), /private regular file/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
