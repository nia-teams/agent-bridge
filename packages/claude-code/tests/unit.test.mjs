import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from '../dist/credentials.js';
import { resolveClaudeBinary } from '../dist/runner.js';
import { contract } from '../../core/tests/helpers.mjs';

function setEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-claude-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
async function loadWithMocks(t, path, replacement) {
  const key = `claudeUnit_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = replacement.values;
  t.after(() => { delete globalThis[key]; });
  const url = new URL(path, import.meta.url);
  const source = (await readFile(url, 'utf8'))
    .replace(replacement.pattern, replacement.statement.replaceAll('MOCK', `globalThis[${JSON.stringify(key)}]`))
    .replace(/from '([^']+)'/g, (_, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('Claude credential directory uses its product default and environment override', t => {
  setEnv(t, 'NIA_CLAUDE_CONFIG_DIR', undefined);
  assert.equal(defaultConfigDir(), join(homedir(), '.config', 'nia-teams-claude-code'));
  process.env.NIA_CLAUDE_CONFIG_DIR = join(tmpdir(), 'custom-claude-config');
  assert.equal(defaultConfigDir(), process.env.NIA_CLAUDE_CONFIG_DIR);
});

test('Claude binary discovery prioritizes explicit path, then CLAUDE_BIN, and reports missing selections', async t => {
  const dir = await directory(t);
  const explicit = join(dir, 'explicit.mjs'); const configured = join(dir, 'configured.mjs');
  await writeFile(explicit, '// explicit CLI'); await writeFile(configured, '// configured CLI');
  setEnv(t, 'CLAUDE_BIN', configured);
  assert.equal(await resolveClaudeBinary(explicit), explicit);
  assert.equal(await resolveClaudeBinary(), configured);
  const missing = join(dir, 'missing.mjs');
  await assert.rejects(resolveClaudeBinary(missing), error => {
    assert.ok(error.message.includes(`Cannot find claude at ${missing}`));
    return true;
  });
  process.env.CLAUDE_BIN = missing;
  await assert.rejects(resolveClaudeBinary(), /Cannot find claude/);
});

test('Claude runner supplies custom spawning only for batch and CommonJS entries', async t => {
  const dir = await directory(t); let captured;
  const { createClaudeRunner } = await loadWithMocks(t, '../dist/runner.js', {
    pattern: /import \{([^}]+)\} from '@anthropic-ai\/claude-agent-sdk';/,
    statement: 'const {$1} = MOCK;',
    values: {
      query({ options }) {
        captured = options;
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', result: 'done' }; }, close() {} };
      },
      tool: () => ({}), createSdkMcpServer: () => ({ instance: { async close() {} } }),
    },
  });
  for (const [suffix, customSpawn] of [['.cmd', true], ['.bat', true], ['.cjs', true], ['.mjs', false], ['', false]]) {
    const binary = join(dir, suffix ? `claude${suffix}` : 'claude-native');
    await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await createClaudeRunner({ cwd: dir, claudeBin: binary })({
      ...contract, deliveryId: 'unit', prompt: 'hello', signal: new AbortController().signal, session: async () => {},
    });
    assert.equal(captured.pathToClaudeCodeExecutable, binary);
    assert.equal(Object.hasOwn(captured, 'spawnClaudeCodeProcess'), customSpawn, suffix || 'native');
    if (customSpawn) assert.equal(typeof captured.spawnClaudeCodeProcess, 'function');
    assert.equal(captured.strictMcpConfig, true);
  }
});

test('Claude pairing supplies product identity and default config directory while preserving overrides', async t => {
  setEnv(t, 'NIA_CLAUDE_CONFIG_DIR', join(tmpdir(), 'claude-pair-unit'));
  const { pairWithNiaTeams } = await loadWithMocks(t, '../dist/pairing.js', {
    pattern: /import \{ pairHost, runPairingCli as run \} from '@nia-teams\/agent-bridge-core\/pairing';/,
    statement: 'const pairHost = MOCK.pairHost; const run = MOCK.run;',
    values: { pairHost: async options => options, run: async () => {} },
  });
  const defaults = await pairWithNiaTeams();
  assert.equal(defaults.hostPrefix, 'claude-code');
  assert.equal(defaults.clientName, 'Claude Code');
  assert.equal(defaults.cliCommandName, 'nia-claude');
  assert.equal(defaults.configDir, defaultConfigDir());
  const configDir = join(tmpdir(), 'explicit-pair-unit');
  const selected = await pairWithNiaTeams({ configDir, hostLabel: 'Local host' });
  assert.equal(selected.configDir, configDir);
  assert.equal(selected.hostLabel, 'Local host');
});
