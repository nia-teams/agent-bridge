import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ToolHttpServer, connectDaemonArgs } from '@nia-teams/agent-bridge-core';
import { PI_BRANDING, resolvePiBinary, validatePiOptions } from '../dist/index.js';
import { JsonlDecoder, PiRpcClient } from '../dist/rpc-client.js';
import { LegacyTurnCompletion, promptDisposition } from '../dist/turn-completion.js';
import extension from '../dist/pi-extension.js';

const cli = fileURLToPath(new URL('../bin/nia-pi.mjs', import.meta.url));
const mock = fileURLToPath(new URL('./mock-pi.mjs', import.meta.url));
const exec = (...args) => promisify(execFile)(process.execPath, [cli, ...args]);
function setEnv(t, name, value) {
  const original = process.env[name]; process.env[name] = value;
  t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
}

test('CLI validates runtime options and forwards only daemon options', async () => {
  assert.match((await exec('--help')).stdout, /nia-pi start .*--pi-bin/);
  assert.match((await exec('connect', '--help')).stdout, /nia-pi connect \[--group-link/);
  await assert.rejects(exec('start', '--thinking', 'wrong'), /Invalid --thinking/);
  await assert.rejects(exec('start', '--provider', 'example'), /requires --model/);
  await assert.rejects(exec('start', '--model', ''), /--model must not be empty/);
  validatePiOptions({ cwd: '.', model: 'example', provider: 'example', thinking: 'xhigh' });
  assert.deepEqual(connectDaemonArgs({ 'group-link': 'token', 'agent-name': 'Test', 'server-url': 'https://example.com', label: 'host', 'no-start': true, 'no-browser': true, model: 'id', provider: 'prov', thinking: 'high', 'pi-bin': mock }),
    ['start', '--daemon', '--model', 'id', '--pi-bin', mock, '--provider', 'prov', '--thinking', 'high']);
});

test('Pi executable selection honors explicit paths over PI_BIN', async t => {
  setEnv(t, 'PI_BIN', '/missing/pi-binary');
  assert.equal(await resolvePiBinary(mock), mock);
  await assert.rejects(resolvePiBinary(), /Cannot find pi at/);
  process.env.PI_BIN = mock;
  assert.equal(await resolvePiBinary(), mock);
});

test('the Pi avatar is a 256x256 PNG below 64 KiB', () => {
  assert.equal(PI_BRANDING.clientName, 'Pi');
  assert.match(PI_BRANDING.avatar, /^data:image\/png;base64,/);
  const png = Buffer.from(PI_BRANDING.avatar.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
  assert.ok(png.length < 64 * 1024);
});

test('JSONL keeps U+2028 and U+2029, accepts CRLF and handles arbitrary UTF-8 chunks', () => {
  const decoder = new JsonlDecoder(), seen = [];
  const first = { type: 'event', message: 'one\u2028二\u2029three' }, second = { type: 'response' };
  const bytes = Buffer.from(`${JSON.stringify(first)}\r\n${JSON.stringify(second)}\n`);
  for (const byte of bytes) decoder.push(Buffer.from([byte]), r => seen.push(r));
  assert.deepEqual(seen, [first, second]);
});

test('responses correlate by ID rather than request order', async t => {
  const child = spawn(process.execPath, ['-e', `
    let input = '', queue = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      const lines = (input + chunk).split('\\n'); input = lines.pop();
      for (const line of lines) {
        queue.push(JSON.parse(line));
        if (queue.length === 2) for (const { id, type } of queue.reverse()) {
          console.log(JSON.stringify({ id, type: 'response', command: type, success: true, data: type }));
        }
      }
    });`], { stdio: 'pipe' });
  const rpc = new PiRpcClient(child);
  t.after(() => rpc.close());
  assert.deepEqual(await Promise.all([rpc.request('first'), rpc.request('second')]), ['first', 'second']);
});

test('the extension registers exact schemas, calls real ToolHttpServer and propagates errors', async t => {
  const controller = new AbortController(), calls = [];
  const inputSchema = { type: 'object', properties: { mode: { oneOf: [{ const: 'all' }, { type: 'integer' }] } }, additionalProperties: false };
  const tools = [{ name: 'dynamic_test', description: 'Server description', inputSchema }];
  const server = new ToolHttpServer({ signal: controller.signal, tools, async callTool(name, args) {
    calls.push([name, args]);
    return args.mode === -1 ? { content: 'Rejected by server', isError: true } : { content: 'Collaboration result' };
  } });
  t.after(() => server.close());
  const endpoint = await server.start();
  setEnv(t, 'NIA_BRIDGE_MCP_URL', endpoint.url);
  setEnv(t, 'NIA_BRIDGE_MCP_TOKEN', 'wrong-token');
  await assert.rejects(extension({ registerTool: () => assert.fail('registered without auth') }), /HTTP 401/);
  process.env.NIA_BRIDGE_MCP_TOKEN = endpoint.headers.Authorization.slice('Bearer '.length);
  const registered = [];
  await extension({ registerTool: tool => registered.push(tool) });
  assert.equal(registered.length, 1);
  const [tool] = registered;
  assert.equal(tool.name, 'dynamic_test');
  assert.equal(tool.description, tools[0].description);
  assert.deepEqual(tool.parameters, inputSchema);
  assert.deepEqual(await tool.execute('one', { mode: 'all' }), { content: [{ type: 'text', text: 'Collaboration result' }], details: {} });
  await assert.rejects(tool.execute('two', { mode: -1 }), /Rejected by server/);
  await assert.rejects(tool.execute('three', { mode: 3 }, AbortSignal.abort()), { name: 'AbortError' });
  assert.deepEqual(calls, [['dynamic_test', { mode: 'all' }], ['dynamic_test', { mode: -1 }]]);
});


test('selects completion by the verified prompt response shape, not a version string', () => {
  assert.equal(promptDisposition(undefined), 'legacy');
  assert.equal(promptDisposition({}), 'legacy');
  for (const disposition of ['handled', 'started', 'queued']) assert.equal(promptDisposition({ disposition }), disposition);
  assert.throws(() => promptDisposition({ disposition: 'unknown' }), /Invalid Pi RPC prompt disposition/);
});

test('legacy settlement rejects busy and stale state and waits through future continuations', () => {
  const progress = new LegacyTurnCompletion();
  const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  progress.observe({ type: 'agent_end' }, 1);
  assert.equal(progress.canCheck(200, 200), false);
  assert.equal(progress.canCheck(201, 200), true);
  const beforeRetry = progress.revision;
  progress.observe({ type: 'auto_retry_start' }, 210);
  assert.equal(progress.acceptState(idle, beforeRetry), false);
  assert.equal(progress.canCheck(1000, 200), false);
  progress.observe({ type: 'auto_retry_end' }, 1020);
  assert.equal(progress.canCheck(1300, 200), false, 'retry_end does not replace agent_end');
  progress.observe({ type: 'agent_end' }, 1310);
  progress.observe({ type: 'compaction_start' }, 1320);
  assert.equal(progress.canCheck(1600, 200), false);
  progress.observe({ type: 'compaction_end', willRetry: true }, 1610);
  assert.equal(progress.canCheck(1900, 200), false, 'overflow schedules a separate agent run');
  progress.observe({ type: 'agent_end' }, 1910);
  assert.equal(progress.acceptState({ ...idle, isStreaming: true }, progress.revision), false);
  assert.equal(progress.acceptState({ ...idle, isCompacting: true }, progress.revision), false);
  assert.equal(progress.acceptState({ ...idle, pendingMessageCount: 1 }, progress.revision), false);
  assert.equal(progress.acceptState(idle, progress.revision), true);
});

function rpcTestChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: signal => assert.fail(`Unexpected escalation to ${signal}`),
  });
  return child;
}

test('abort shutdown settles on a spawn error without needing a later close event', { timeout: 1000 }, async () => {
  const child = rpcTestChild(undefined);
  const rpc = new PiRpcClient(child);
  const pending = rpc.request('get_state');
  const closing = rpc.close(true);
  const failed = assert.rejects(pending, { code: 'ENOENT' });
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  await Promise.all([failed, closing]);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});

test('abort shutdown waits for acknowledgment, then EOF, then child close', { timeout: 1000 }, async () => {
  const child = rpcTestChild(123);
  const rpc = new PiRpcClient(child);
  const commands = [];
  child.stdin.on('data', data => commands.push(JSON.parse(data)));
  let finished = false;
  const closing = rpc.close(true);
  assert.equal(rpc.close(), closing, 'both callers share cleanup');
  void closing.then(() => { finished = true; });
  const [abort] = commands;
  assert.equal(abort.type, 'abort');
  assert.equal(child.stdin.writableEnded, false);
  child.stdout.write(`${JSON.stringify({ type: 'response', id: abort.id, command: 'abort', success: true })}\n`);
  await immediate();
  assert.equal(child.stdin.writableEnded, true);
  child.emit('error', new Error('live child error'));
  await immediate();
  assert.equal(finished, false, 'neither abort acknowledgment nor a live child error signals closure');
  child.emit('close', 0, null);
  await closing;
});

test('legacy idle before a delayed agent_start never completes a turn', () => {
  const progress = new LegacyTurnCompletion();
  const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  const revision = progress.revision;
  assert.equal(progress.hasRunBoundary, false);
  assert.equal(progress.canCheck(200, 200), false);
  assert.equal(progress.acceptState(idle, revision), false);
  progress.observe({ type: 'agent_start' }, 650);
  assert.equal(progress.hasRunBoundary, true);
  assert.equal(progress.acceptState(idle, progress.revision), false);
  assert.equal(progress.canCheck(999, 200), false);
  progress.observe({ type: 'agent_end' }, 1000);
  assert.equal(progress.acceptState(idle, revision), false, 'pre-run response remains stale');
  assert.equal(progress.canCheck(1200, 200), true);
  assert.equal(progress.acceptState(idle, progress.revision), true);
});
