import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../../core/dist/index.js';
import { fixture, until, sessionId } from '../../core/tests/helpers.mjs';

for (const credentials of ['paired', 'missing']) {
  test(`daemon-inherited legacy MCP is healthy and cannot replace the parent (${credentials} credentials)`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const parent = new BridgeClient(f.credentials);
    t.after(() => parent.close());
    await parent.start();
    const socket = f.socket;
    const connections = f.connections;
    const requests = f.requests.length;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/nia-claude.mjs', import.meta.url)), 'mcp', '--config-dir', credentials === 'paired' ? f.dir : join(f.dir, 'no-credentials')], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NIA_CLAUDE_DAEMON: '1' },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
    const frames = () => stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    const response = id => frames().find(frame => frame.id === id);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'daemon-child', version: '1' } } });
    await until(() => response(1), 'idle initialize');
    assert.equal(response(1).result.serverInfo.name, 'nia-teams');
    assert.deepEqual(response(1).result.capabilities, { tools: {} });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'ping' });
    await until(() => response(2) && response(3), 'idle tool list and ping');
    assert.deepEqual(response(2).result, { tools: [] });
    assert.deepEqual(response(3).result, {});
    assert.equal(f.connections, connections, 'nested MCP must not open a WebSocket');
    assert.equal(f.requests.length, requests, 'nested MCP must not acquire a challenge or lease');
    assert.equal(f.socket, socket);
    assert.equal(f.sockets.size, 1);
    assert.deepEqual(await parent.rpc('group_chat.history', { sessionId }), { text: 'Earlier chat' });
    child.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(stderr, '');
    for (const frame of frames()) assert.equal(frame.jsonrpc, '2.0');
  });
}
