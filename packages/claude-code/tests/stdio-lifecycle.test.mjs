import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, until, message } from './helpers.mjs';

for (const event of ['stdin-end', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`stdio ${event} exits without orphan sockets and stdout contains only JSON-RPC`, async t => {
    const f = await fixture(t);
    const child = spawn(process.execPath, ['bin/nia-claude.mjs', 'mcp', '--config-dir', f.dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = ''; let stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
    await until(() => stdout.includes('"id":1'), 'initialize response');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await until(() => f.socket, 'bridge handshake');
    f.send(message()); await until(() => stdout.includes('notifications/claude/channel'));
    const exited = once(child, 'exit');
    if (event === 'stdin-end') child.stdin.end(); else child.kill(event);
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Child did not exit')), 4000); timer.unref(); })]);
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    await until(() => f.sockets.size === 0);
    assert.ok(f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle'));
    for (const line of stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  });
}
