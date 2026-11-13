import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, message, until } from '../../core/tests/helpers.mjs';

async function start(t, f) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/nia-claude.mjs', import.meta.url)), 'start', '--config-dir', f.dir, '--cwd', f.dir, '--claude-bin', fileURLToPath(new URL('../../../tests/fixtures/mock-sdk-cli.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));
  await until(() => f.socket, 'daemon ready', 10000);
  return { child, exited, stderr: () => stderr };
}

test('nia-claude start survives reconnect at final publication and serves the next turn', { timeout: 20000 }, async t => {
  const f = await fixture(t); const daemon = await start(t, f);
  let dropped = false;
  f.handleRpc = (frame, ws) => {
    if (frame.method === 'group_chat.send_message' && !dropped) { dropped = true; ws.terminate(); return true; }
  };
  f.send(message('hello'));
  await until(() => f.connections === 2 && f.rpcs.filter(r => r.method === 'group_chat.send_message').length === 2, 'publication retry', 10000);
  const sends = f.rpcs.filter(r => r.method === 'group_chat.send_message');
  assert.equal(sends[0].params.toolCallId, sends[1].params.toolCallId);
  f.send(message('next'));
  await until(() => f.rpcs.filter(r => r.method === 'group_chat.send_message').length === 3, 'next turn', 10000);
  assert.equal(daemon.child.exitCode, null);
  assert.doesNotMatch(daemon.stderr(), /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED|unhandled|Agent Bridge is not ready/i);
  daemon.child.kill('SIGTERM');
  assert.deepEqual(await daemon.exited, { code: 0, signal: null });
});

test('nia-claude start reports terminal supersession with exit 1, not silent success', { timeout: 10000 }, async t => {
  const f = await fixture(t); const daemon = await start(t, f);
  // Keep an SDK query active while replacing the host, exercising cleanup too.
  f.send(message('hold'));
  await until(() => f.rpcs.some(r => r.method === 'thread.activity'));
  f.socket.close(4409, 'another host');
  assert.deepEqual(await daemon.exited, { code: 1, signal: null });
  assert.match(daemon.stderr(), /host superseded.*4409.*another host/);
  assert.doesNotMatch(daemon.stderr(), /unhandled|CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/i);
  assert.equal(f.connections, 1);
});
