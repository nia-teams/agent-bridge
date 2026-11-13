import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, chmod, readFile, mkdir, symlink, readdir, writeFile, lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pairWithNiaTeams, loadCredentials, saveCredentials, stableExternalAgentThreadId } from '../dist/index.js';
import { fixture, teamId, groupChatId } from './helpers.mjs';
import { registrationMessage, challengeMessage } from '../dist/crypto.js';
const exec = promisify(execFile);

test('canonical signing strings and deterministic thread ID match byte fixtures', () => {
  assert.equal(registrationMessage('p', 't', 'n', 'u'), 'nia-agent-bridge-register-v1\np\nt\nn\nu');
  assert.equal(challengeMessage({ challengeId: 'c', teamId: 't', keyGeneration: 3, nonce: 'n' }), 'nia-agent-bridge-auth-v1\nc\nt\n3\nn');
  assert.equal(stableExternalAgentThreadId(groupChatId, teamId), 'nia-gc-QAI2QQC6IscVSfM-CAgtx_s5');
});
test('pair uses proof-of-possession, persists private key locally with 600/700 modes', async t => {
  const f = await fixture(t); let shown;
  const result = await pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir, hostLabel: 'my host', pollIntervalMs: 1, onPairing: info => { shown = info; } });
  assert.equal(shown.pairingCode, 'A1B2C3D4'); assert.match(shown.verificationUrl, /pair\?code=/);
  assert.equal(result.teamId, teamId); assert.equal(result.hostLabel, 'my host');
  assert.deepEqual(await loadCredentials(f.dir), result);
  assert.equal((await stat(`${f.dir}/credentials.json`)).mode & 0o777, 0o600);
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes('PRIVATE KEY')));
  await chmod(`${f.dir}/credentials.json`, 0o644);
  await assert.rejects(loadCredentials(f.dir), /private file/);
});
test('CLI pair and status exercise real HTTP routes without printing secrets', async t => {
  const f = await fixture(t);
  const paired = await exec(process.execPath, ['bin/nia-claude.mjs', 'pair', '--server-url', f.url, '--config-dir', f.dir, '--label', 'cli test', '--timeout-ms', '5000']);
  assert.match(paired.stdout, /A1B2C3D4/); assert.match(paired.stdout, /Paired: Helper/); assert.doesNotMatch(paired.stdout, /PRIVATE KEY/);
  f.credentials = JSON.parse(await readFile(`${f.dir}/credentials.json`, 'utf8'));
  const status = await exec(process.execPath, ['bin/nia-claude.mjs', 'status', '--config-dir', f.dir]);
  assert.match(status.stdout, /Challenge\/lease authentication: OK/); assert.doesNotMatch(status.stdout, /lease":|PRIVATE KEY/);
});
test('expired and timed-out pairing fail without replacing saved credentials', async t => {
  const f = await fixture(t); const before = await loadCredentials(f.dir);
  f.pairStatus = 'expired'; await assert.rejects(pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir }), /expired/);
  f.pairStatus = 'pending'; await assert.rejects(pairWithNiaTeams({ serverUrl: f.url, configDir: f.dir, timeoutMs: 50, pollIntervalMs: 5 }));
  assert.deepEqual(await loadCredentials(f.dir), before);
});

async function linkOrSkip(t, target, path, directory = true) {
  try { await symlink(target, path, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symbolic links require Windows developer mode or symlink privilege'); return false; }
    throw error;
  }
}

for (const scenario of ['config-directory', 'missing-child', 'existing-child']) {
  test(`credentials reject ${scenario} directory symlink without modifying its target`, async t => {
    const f = await fixture(t);
    const target = join(f.dir, 'untrusted-target'); await mkdir(target, { mode: 0o755 });
    const targetConfig = scenario === 'existing-child' ? join(target, 'sub') : target;
    if (targetConfig !== target) await mkdir(targetConfig, { mode: 0o755 });
    await writeFile(join(targetConfig, 'credentials.json'), JSON.stringify(f.credentials), { mode: 0o600 });
    const before = await readFile(join(targetConfig, 'credentials.json'));
    const mode = (await stat(target)).mode; const configMode = (await stat(targetConfig)).mode;
    const link = join(f.dir, 'symlinked-parent');
    if (!await linkOrSkip(t, target, link)) return;
    const configDir = scenario === 'config-directory' ? link : join(link, 'sub');
    await assert.rejects(saveCredentials(f.credentials, configDir), /symbolic link/);
    await assert.rejects(loadCredentials(configDir), /symbolic link/);
    assert.deepEqual(await readFile(join(targetConfig, 'credentials.json')), before);
    assert.equal((await stat(target)).mode, mode); assert.equal((await stat(targetConfig)).mode, configMode);
    assert.deepEqual((await readdir(target)).sort(), scenario === 'existing-child' ? ['sub'] : ['credentials.json']);
    assert.deepEqual(await readdir(targetConfig), ['credentials.json']);
    assert.ok((await lstat(link)).isSymbolicLink());
  });
}

for (const dangling of [false, true]) {
  test(`credentials reject ${dangling ? 'dangling' : 'existing'} credentials.json symlink without replacing it`, async t => {
    const f = await fixture(t); const configDir = join(f.dir, 'config'); await mkdir(configDir, { mode: 0o700 });
    const target = join(f.dir, 'linked-credentials.json');
    if (!dangling) await writeFile(target, JSON.stringify(f.credentials), { mode: 0o600 });
    const before = dangling ? undefined : await readFile(target);
    if (!await linkOrSkip(t, target, join(configDir, 'credentials.json'), false)) return;
    await assert.rejects(saveCredentials(f.credentials, configDir), /symbolic link/);
    await assert.rejects(loadCredentials(configDir), /symbolic link/);
    assert.ok((await lstat(join(configDir, 'credentials.json'))).isSymbolicLink());
    assert.deepEqual(await readdir(configDir), ['credentials.json']);
    if (dangling) await assert.rejects(lstat(target), { code: 'ENOENT' });
    else assert.deepEqual(await readFile(target), before);
  });
}

test('credentials reject non-regular targets and create private nested directories', async t => {
  const f = await fixture(t); const configDir = join(f.dir, 'new', 'nested', 'config');
  await saveCredentials(f.credentials, configDir);
  assert.deepEqual(await loadCredentials(configDir), f.credentials);
  if (process.platform !== 'win32') {
    for (const path of [join(f.dir, 'new'), join(f.dir, 'new', 'nested'), configDir]) assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(configDir, 'credentials.json'))).mode & 0o777, 0o600);
  }
  const invalid = join(f.dir, 'invalid'); await mkdir(join(invalid, 'credentials.json'), { recursive: true });
  await assert.rejects(saveCredentials(f.credentials, invalid), /regular private file/);
  await assert.rejects(loadCredentials(invalid), /regular private file/);
});


for (const variable of ['HOME', 'TMPDIR']) {
  test(`${variable} symlink cannot bypass default or explicit credential path validation`, async t => {
    const f = await fixture(t); const target = join(f.dir, 'environment-target'); await mkdir(target, { mode: 0o755 });
    const alias = join(f.dir, 'environment-alias'); if (!await linkOrSkip(t, target, alias)) return;
    // Seed valid files so a successful load would demonstrate a real bypass.
    const suffix = variable === 'HOME' ? ['.config', 'nia-teams-claude-code'] : ['nested', 'config'];
    const targetConfig = join(target, ...suffix); await mkdir(targetConfig, { recursive: true, mode: 0o755 });
    await writeFile(join(targetConfig, 'credentials.json'), JSON.stringify(f.credentials), { mode: 0o600 });
    const before = await readFile(join(targetConfig, 'credentials.json'));
    const targetMode = (await stat(target)).mode; const configMode = (await stat(targetConfig)).mode;
    const env = { ...process.env };
    if (variable === 'HOME') {
      env.HOME = alias; env.USERPROFILE = alias;
      delete env.NIA_CLAUDE_CONFIG_DIR;
    } else {
      env.TMPDIR = alias; env.TEMP = alias; env.TMP = alias;
      env.NIA_CLAUDE_CONFIG_DIR = join(alias, ...suffix);
    }
    await exec(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { defaultConfigDir, saveCredentials, loadCredentials } from './dist/index.js';
      const credentials = await loadCredentials(process.argv[1]);
      // defaultConfigDir selects a path, not a trust boundary: both its implicit
      // and explicit uses must pass the exact same symlink checks.
      const selected = defaultConfigDir();
      assert.equal(selected, process.argv[2]);
      await assert.rejects(saveCredentials(credentials), /symbolic link/);
      await assert.rejects(loadCredentials(), /symbolic link/);
      await assert.rejects(saveCredentials(credentials, selected), /symbolic link/);
      await assert.rejects(loadCredentials(selected), /symbolic link/);
      if (process.argv[3] === 'TMPDIR') {
        const config = join(tmpdir(), 'nested', 'config');
        await assert.rejects(saveCredentials(credentials, config), /symbolic link/);
        await assert.rejects(loadCredentials(config), /symbolic link/);
      }
    `, f.dir, join(alias, ...suffix), variable], { env });
    assert.deepEqual(await readFile(join(targetConfig, 'credentials.json')), before);
    assert.equal((await stat(target)).mode, targetMode);
    assert.equal((await stat(targetConfig)).mode, configMode);
    assert.deepEqual(await readdir(target), [suffix[0]]);
    assert.deepEqual(await readdir(targetConfig), ['credentials.json']);
    assert.ok((await lstat(alias)).isSymbolicLink());
  });
}

// Isolate root-path cases from the host filesystem so regressions cannot chmod
// a system directory or create /credentials.json while exercising rejection.
async function rootPathFixture(entries) {
  const mutations = [];
  const directory = uid => ({ uid, isDirectory: () => true, isSymbolicLink: () => false });
  const link = uid => ({ uid, isDirectory: () => false, isSymbolicLink: () => true });
  const filesystem = {
    async lstat(path) {
      const entry = entries[path];
      if (!entry) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      return entry.type === 'link' ? link(entry.uid) : directory(entry.uid);
    },
    async realpath(path) { return entries[path]?.target ?? path; },
  };
  for (const name of ['chmod', 'mkdir', 'readFile', 'rename', 'rm', 'writeFile']) {
    filesystem[name] = async (...args) => { mutations.push({ name, args }); throw new Error('Unexpected filesystem access'); };
  }
  const key = `credentialFs_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = filesystem;
  const source = (await readFile(new URL('../../core/dist/credentials.js', import.meta.url), 'utf8'))
    .replace(/import \{([^}]+)\} from 'node:fs\/promises';/, `const {$1} = globalThis[${JSON.stringify(key)}];`)
    .replace("'./http.js'", JSON.stringify(new URL('../../core/dist/http.js', import.meta.url).href));
  try {
    return { ...(await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)), mutations };
  } finally { delete globalThis[key]; }
}

test('filesystem root configDir is rejected before any read or mutation', async () => {
  const { parse, resolve } = await import('node:path');
  const root = parse(resolve('.')).root;
  const f = await rootPathFixture({ [root]: { type: 'directory', uid: 0 } });
  await assert.rejects(f.saveCredentials({}, root), /Filesystem root cannot/);
  await assert.rejects(f.loadCredentials(root), /Filesystem root cannot/);
  assert.deepEqual(f.mutations, []);
});

for (const scenario of ['single-component', 'unlisted-root-alias', 'non-root-link', 'non-root-target']) {
  test(`${scenario} symlink is never an exempt credential base`, { skip: process.platform === 'win32' }, async () => {
    const name = scenario === 'single-component' ? 'workspace' : scenario === 'unlisted-root-alias' ? 'unlisted' : 'workspace';
    const f = await rootPathFixture({
      '/': { type: 'directory', uid: 0 },
      [`/${name}`]: { type: 'link', uid: scenario === 'non-root-link' ? 1000 : 0, target: '/resolved' },
      '/resolved': { type: 'directory', uid: scenario === 'non-root-target' ? 1000 : 0 },
    });
    const config = scenario === 'single-component' ? `/${name}` : `/${name}/config`;
    await assert.rejects(f.saveCredentials({}, config), /symbolic link/);
    await assert.rejects(f.loadCredentials(config), /symbolic link/);
    assert.deepEqual(f.mutations, []);
  });
}
