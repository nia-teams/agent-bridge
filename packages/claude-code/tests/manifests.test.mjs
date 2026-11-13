import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const localPath = path => {
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0);
  const target = resolve(root, path);
  const rest = relative(root, target);
  assert.ok(rest !== '..' && !rest.startsWith(`..${sep}`), `Reference escapes plugin root: ${path}`);
  return target;
};

test('marketplace, plugin and package identities and versions remain aligned', async () => {
  const [marketplace, plugin, pkg, lock] = await Promise.all([
    json('.claude-plugin/marketplace.json'), json('.claude-plugin/plugin.json'), json('package.json'), json('../../package-lock.json'),
  ]);
  assert.equal(marketplace.$schema, 'https://json.schemastore.org/claude-code-marketplace.json');
  assert.equal(marketplace.name, 'nia-teams');
  assert.equal(plugin.name, marketplace.name);
  assert.equal(pkg.name, '@nia-teams/claude-code-plugin');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(marketplace.version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(lock.packages['packages/claude-code'].version, pkg.version);
  assert.deepEqual(marketplace.owner, { name: 'Nia Teams', url: pkg.homepage });
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.description, plugin.description);
  assert.deepEqual(entry.keywords, plugin.keywords);
  assert.equal(entry.category, 'productivity');
  assert.equal(entry.source, './');
  assert.equal(localPath(entry.source), resolve(root));
  assert.ok((await stat(localPath(entry.source))).isDirectory());
  assert.equal(pkg.repository.url, `${plugin.repository}.git`);
});

test('repository marketplace resolves the packaged plugin and stays synchronized', async () => {
  const [repositoryMarketplace, packageMarketplace] = await Promise.all([
    json('../../.claude-plugin/marketplace.json'), json('.claude-plugin/marketplace.json'),
  ]);
  const entry = repositoryMarketplace.plugins[0];
  assert.equal(entry.source, './packages/claude-code');
  assert.equal(resolve(root, '../..', entry.source), resolve(root));
  assert.deepEqual(repositoryMarketplace, {
    ...packageMarketplace,
    plugins: packageMarketplace.plugins.map(plugin => ({ ...plugin, source: './packages/claude-code' })),
  });
});

test('plugin skill, MCP startup and package export references exist and are valid', async () => {
  const [plugin, mcp, pkg] = await Promise.all([json('.claude-plugin/plugin.json'), json('.mcp.json'), json('package.json')]);
  assert.deepEqual(plugin.skills, ['./skills/nia-teams-claude-code']);
  for (const skill of plugin.skills) {
    assert.ok(skill.startsWith('./'));
    assert.ok((await stat(localPath(skill))).isDirectory());
    const text = await readFile(resolve(localPath(skill), 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: nia-teams-claude-code\ndescription: .+\n---/);
  }
  assert.deepEqual(Object.keys(mcp.mcpServers), [plugin.name]);
  assert.deepEqual(mcp.mcpServers[plugin.name], { command: 'npx', args: ['-y', pkg.name, 'mcp'] });
  assert.deepEqual(pkg.bin, { 'nia-claude': 'bin/nia-claude.mjs' });
  for (const path of [pkg.bin['nia-claude'], pkg.main, pkg.types, pkg.exports['.'].types, pkg.exports['.'].import]) {
    assert.ok((await stat(localPath(path))).isFile());
  }
  assert.match(await readFile(localPath(pkg.bin['nia-claude']), 'utf8'), /import \{ main \} from '\.\.\/dist\/cli\.js'/);
  assert.ok((await stat(localPath('dist/cli.js'))).isFile());
  assert.ok(pkg.files.includes('.claude-plugin'));
  assert.ok(!pkg.files.includes('.claude-plugin/plugin.json'));
  for (const path of ['.mcp.json', 'skills', 'dist', 'bin', 'docs', 'examples', 'AGENTS.md', 'CLAUDE.md']) {
    assert.ok(pkg.files.includes(path), `Missing package files entry: ${path}`);
    await access(localPath(path));
  }
  await assert.rejects(access(localPath('examples/local-mcp.json')), { code: 'ENOENT' });
});

test('installation guidance stays global and maintainer files remain synchronized', async () => {
  const docs = ['README.md', 'README_CN.md', 'AGENTS.md', 'CLAUDE.md', 'skills/nia-teams-claude-code/SKILL.md'];
  for (const path of docs) {
    const text = await readFile(localPath(path), 'utf8');
    for (const command of [
      'claude plugin marketplace add nia-teams/agent-bridge',
      'claude plugin install nia-teams@nia-teams --scope user',
      "npx @nia-teams/claude-code-plugin pair --label 'claude@macbook'",
      '--dangerously-load-development-channels plugin:nia-teams@nia-teams',
    ]) assert.ok(text.includes(command), `${path} is missing ${command}`);
    assert.ok(!text.includes('examples/local-mcp.json'));
  }
  assert.equal(await readFile(localPath('AGENTS.md'), 'utf8'), await readFile(localPath('CLAUDE.md'), 'utf8'));
});
