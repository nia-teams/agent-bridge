import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { fixture, message, until, agentThreadId } from './helpers.mjs';
import * as plugin from '../dist/index.js';

test('real cordis.yml Loader sees named exports/inject, publishes a user-visible reply, and unloads tools/Agents', async t => {
  const f = await fixture(t);
  const configPath = `${f.dir}/cordis.yml`;
  await writeFile(configPath, [
    '- id: host-services', `  name: ${JSON.stringify(new URL('./fixtures/host-services.mjs', import.meta.url).href)}`,
    '- id: nia-teams', `  name: ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}`,
    '  config:', `    configDir: ${JSON.stringify(f.dir)}`,
  ].join('\n'));
  assert.equal('default' in plugin, false); assert.deepEqual(plugin.inject, ['agents']);
  const ctx = new Context(); ctx.baseUrl = pathToFileURL(process.cwd()).href + '/';
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  const includeId = await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: configPath } });
  await ctx.loader.await();
  await until(() => f.socket, 'plugin handshake through Loader');
  f.send(message());
  await until(() => f.rpcs.some(rpc => rpc.method === 'group_chat.send_message'), 'automatic GroupChat reply');
  assert.equal(f.rpcs.find(rpc => rpc.method === 'group_chat.send_message').params.content, 'Loaded Agent says hello');
  const probe = ctx.get('testProbe'); assert.equal(probe.follows.length, 1); assert.equal(probe.tools.size, 2);
  const include = ctx.loader.resolve(includeId).subtree;
  const entry = include.resolve('nia-teams');
  await entry.fiber.dispose();
  assert.equal(probe.tools.size, 0); assert.deepEqual(probe.disposed, [agentThreadId]);
  assert.equal(probe.agents.size, 0);
});
