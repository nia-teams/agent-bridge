import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixture, until, message } from './helpers.mjs';

const exec = promisify(execFile);
const local = path => fileURLToPath(new URL(`../${path}`, import.meta.url));

test('both core READMEs embed the shipped ESM examples verbatim', async () => {
  for (const language of ['README.md', 'README_CN.md']) {
    const readme = await readFile(local(language), 'utf8');
    for (const name of ['pair.mjs', 'connect.mjs']) {
      assert.ok(readme.includes(`\`\`\`js\n${await readFile(local(`examples/${name}`), 'utf8')}\`\`\``));
    }
  }
});

test('core ESM examples pair, connect, publish and shut down', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.pendingPolls = 0;
  const env = { ...process.env, MY_AGENT_CONFIG_DIR: f.dir, NIA_TEAMS_URL: f.url };
  const pair = await exec(process.execPath, [local('examples/pair.mjs')], { env });
  assert.ok(pair.stdout.includes(f.url));
  f.credentials = JSON.parse(await readFile(`${f.dir}/credentials.json`, 'utf8'));
  const child = spawn(process.execPath, [local('examples/connect.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));
  await until(() => f.socket && stdout.includes('Connected:'), 'example connection');
  const frame = message('Hello example');
  f.send(frame);
  await until(() => f.rpcs.some(rpc => rpc.method === 'group_chat.send_message'), 'example reply');
  assert.deepEqual(f.rpcs.find(rpc => rpc.method === 'group_chat.send_message').params, {
    sessionId: frame.sessionId, toolCallId: frame.deliveryId, content: 'Received',
  });
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
});
