import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, ['bin/nia-claude.mjs', ...args], { cwd: root });

test('package ships only the SDK daemon entrypoints and documentation', async () => {
  const pkg = await json('package.json');
  assert.equal(pkg.name, '@nia-teams/claude-code-plugin');
  assert.deepEqual(pkg.files, ['dist', 'bin', 'skills', 'AGENTS.md', 'docs', 'README.md', 'README_CN.md', 'LICENSE']);
  assert.deepEqual(pkg.bin, { 'nia-claude': 'bin/nia-claude.mjs' });
  assert.deepEqual(pkg.exports, {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './package.json': './package.json',
  });
  assert.equal(pkg.main, pkg.exports['.'].import);
  assert.equal(pkg.types, pkg.exports['.'].types);
  for (const path of [...pkg.files, ...Object.values(pkg.bin), pkg.main, pkg.types]) await access(new URL(path, root));
  const entries = await readdir(root);
  assert.deepEqual(entries.filter(name => name.startsWith('.')).sort(), ['.gitignore', '.npmrc']);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', '@nia-teams/agent-bridge-core', 'zod']);
  const lock = await json('../../package-lock.json');
  assert.equal(lock.packages['packages/claude-code'].version, pkg.version);
  assert.deepEqual(lock.packages['packages/claude-code'].dependencies, pkg.dependencies);
});

test('public module exposes the runner, core lifecycle, pairing, and credentials', async () => {
  const api = await import('../dist/index.js');
  assert.deepEqual(Object.keys(api).sort(), [
    'BridgeClient', 'BridgeRpcError', 'PublicationQueue', 'SessionHost',
    'acquireLease', 'createClaudeRunner', 'defaultConfigDir', 'loadCredentials',
    'pairWithNiaTeams', 'resolveClaudeBinary', 'saveCredentials', 'stableExternalAgentThreadId',
  ].sort());
});

test('CLI help lists the four commands and runtime options', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const { stdout, stderr } = await cli(...args);
    assert.equal(stderr, '');
    assert.deepEqual([...stdout.matchAll(/^nia-claude (\w+)/gm)].map(match => match[1]).sort(), ['connect', 'pair', 'start', 'status']);
    for (const flag of ['--name', '--cwd', '--model', '--full-auto', '--claude-bin', '--daemon', '--log-file']) assert.ok(stdout.includes(flag), flag);
  }
});

test('CLI rejects unsupported commands and multiple commands with the supported command list', async () => {
  for (const args of [['unsupported'], ['mcp'], ['pair', 'start']]) {
    await assert.rejects(cli(...args), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /(?:Unknown command|Expected one command).*connect, pair, status, or start/);
      return true;
    });
  }
  await assert.rejects(cli('connect'), /connect requires --invite-code/);
});
