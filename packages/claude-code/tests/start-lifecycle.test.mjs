import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, message, until } from '../../core/tests/helpers.mjs';

async function start(t, f, flags) {
  const log = join(f.dir, 'sdk.log');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/nia-claude.mjs', import.meta.url)), 'start', ...flags, '--config-dir', f.dir, '--cwd', f.dir, '--claude-bin', fileURLToPath(new URL('../../../tests/fixtures/mock-sdk-cli.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NIA_MOCK_LOG: log } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));
  await until(() => f.socket, 'daemon ready', 10000);
  return { child, exited, log, stderr: () => stderr };
}

test('nia-claude start survives reconnect at final publication and serves the next turn', { timeout: 20000 }, async t => {
  const f = await fixture(t); const daemon = await start(t, f, ['--require-approval']);
  let dropped = false;
  f.handleRpc = (frame, ws) => {
    if ((frame.method === 'tool.call' && frame.params.name === 'send_message') && !dropped) { dropped = true; ws.terminate(); return true; }
  };
  f.send(message('use tools'));
  await until(() => f.connections === 2 && f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length === 2, 'publication retry', 10000);
  const sends = f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message'));
  assert.equal(sends[0].params.toolCallId, sends[1].params.toolCallId);
  f.send(message('use tools again'));
  await until(() => f.rpcs.filter(r => (r.method === 'tool.call' && r.params.name === 'send_message')).length === 3, 'next turn', 10000);
  assert.equal(daemon.child.exitCode, null);
  assert.doesNotMatch(daemon.stderr(), /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED|unhandled|Agent Bridge is not ready/i);
  daemon.child.kill('SIGTERM');
  assert.deepEqual(await daemon.exited, { code: 0, signal: null });
});

test('nia-claude start reports terminal supersession with exit 1, not silent success', { timeout: 10000 }, async t => {
  const f = await fixture(t); const daemon = await start(t, f, ['--require-approval']);
  // Keep an SDK query active while replacing the host, exercising cleanup too.
  f.send(message('hold'));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity'));
  f.socket.close(4409, 'another host');
  assert.deepEqual(await daemon.exited, { code: 1, signal: null });
  assert.match(daemon.stderr(), /host superseded.*4409.*another host/);
  assert.doesNotMatch(daemon.stderr(), /unhandled|CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/i);
  assert.equal(f.connections, 1);
});

for (const flag of [undefined, '--full-auto', '--require-approval']) test(`nia-claude start configures tool approvals: ${flag ?? 'no flag'}`, async t => {
  const f = await fixture(t);
  const daemon = await start(t, f, flag ? [flag] : []);
  const requireApproval = flag === '--require-approval';
  f.send(message('permission'));
  if (requireApproval) {
    await until(() => f.rpcs.some(r => r.method === 'card.upsert'));
    await f.confirm(f.rpcs.find(r => r.method === 'card.upsert'));
  }
  await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
  const entries = (await readFile(daemon.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const { args } = entries.find(entry => entry.kind === 'spawn' && !entry.args.includes('--version'));
  assert.equal(args.find(arg => arg.startsWith('--permission-mode='))?.split('=')[1], requireApproval ? 'default' : 'bypassPermissions');
  assert.equal(entries.find(entry => entry.kind === 'permission').result.behavior, 'allow');
  assert.equal(f.rpcs.some(r => r.method === 'card.upsert'), requireApproval);
  daemon.child.kill('SIGTERM');
  assert.deepEqual(await daemon.exited, { code: 0, signal: null });
});
