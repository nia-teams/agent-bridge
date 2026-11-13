import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, chmod, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ThreadStore, AppServer } from '../dist/index.js';
const bin = fileURLToPath(new URL('./mock-codex.mjs', import.meta.url));
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'nia-codex-unit-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('ThreadStore persists concurrent updates and reloads with private modes', async t => {
  const d = await dir(t), store = new ThreadStore(d); await store.load();
  const a = { codexThreadId: 'a', groupChatId: 'group-a', updatedAt: new Date().toISOString() }, b = { ...a, codexThreadId: 'b' };
  await Promise.all([store.set('a', a), store.set('b', b)]);
  const reloaded = new ThreadStore(d); await reloaded.load();
  assert.deepEqual(reloaded.get('a'), a); assert.deepEqual(reloaded.get('b'), b);
  assert.equal((await stat(join(d, 'threads.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(d)).mode & 0o777, 0o700);
});

test('ThreadStore rejects symlink targets on read and write without overwriting destination', async t => {
  const d = await dir(t), target = join(d, 'other'); await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, join(d, 'threads.json'));
  const store = new ThreadStore(d);
  await assert.rejects(store.load(), /private regular file/);
  await assert.rejects(store.set('a', { codexThreadId: 'a', groupChatId: 'g', updatedAt: 'now' }), /Invalid threads/);
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('ThreadStore rejects invalid data and public permissions', async t => {
  const d = await dir(t), path = join(d, 'threads.json');
  await writeFile(path, '{"bad":{}}', { mode: 0o600 });
  await assert.rejects(new ThreadStore(d).load(), /Invalid thread mapping/);
  await writeFile(path, '[]'); await assert.rejects(new ThreadStore(d).load(), /Invalid thread mappings/);
  await writeFile(path, '{}'); await chmod(path, 0o644);
  await assert.rejects(new ThreadStore(d).load(), /private regular file/);
});

test('AppServer handles string server IDs, unknown methods, and rejects pending calls on close', async t => {
  const app = new AppServer(bin); t.after(() => app.close());
  app.onMessage = m => { if (m.id !== undefined) app.respond(m.id, { success: true }); };
  await app.start();
  await app.request('test/emit', { message: { id: 'server-id', method: 'probe', params: {} } });
  const { log } = await app.request('test/log', {});
  assert.equal(log.find(m => m.id === 'server-id').result.success, true);
  const pending = app.request('test/emit', { message: { method: 'notification', params: {} } });
  app.close(); await assert.rejects(pending, /closed/);
});

test('AppServer spawn errors reject initialize instead of hanging', async () => {
  const app = new AppServer('/no/such/codex', 100);
  await assert.rejects(app.start(), /ENOENT/); app.close();
});

test('AppServer launches a non-executable JS entrypoint through Node', async t => {
  const d = await dir(t), script = join(d, 'mock codex.mjs');
  await writeFile(script, await readFile(bin));
  await chmod(script, 0o600);
  const app = new AppServer(script, 3000);
  t.after(() => app.close());
  await app.start();
  assert.ok(app.pid);
});
