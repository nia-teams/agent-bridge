import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('Codex plugin points to the adapter skill and a bundled composer icon', async () => {
  const manifest = await readJson('.codex-plugin/plugin.json');
  const adapter = await readJson('packages/codex/package.json');

  assert.equal(manifest.version, adapter.version);
  assert.equal(manifest.license, adapter.license);
  assert.equal(manifest.skills, './packages/codex/skills/');
  const skill = new URL('nia-teams-codex/SKILL.md', new URL(manifest.skills, root));
  assert.match(await readFile(skill, 'utf8'), /^---\r?\nname: nia-teams-codex\r?\n/);

  const icon = new URL(manifest.interface.composerIcon, root);
  assert.ok(icon.href.startsWith(root.href));
  const info = await stat(icon);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 50 * 1024);
});
