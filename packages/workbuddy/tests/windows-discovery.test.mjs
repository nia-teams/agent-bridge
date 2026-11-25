import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runnerUrl = new URL('../dist/runner.js', import.meta.url);
const require = createRequire(runnerUrl);
const asUrl = name => JSON.stringify(pathToFileURL(require.resolve(name)).href);

async function loadWindowsRunner(home, nativeWindowsPaths = false) {
  const source = (await readFile(runnerUrl, 'utf8'))
    .replace("import { homedir, platform } from 'node:os';", `const homedir = () => ${JSON.stringify(home)}, platform = () => 'win32';`)
    .replace("'@tencent-ai/agent-sdk'", asUrl('@tencent-ai/agent-sdk'))
    .replace("'@nia-teams/agent-bridge-core'", JSON.stringify(new URL('../../core/dist/index.js', runnerUrl).href))
    .replace("import { basename, dirname, join } from 'node:path';", nativeWindowsPaths ? "import { win32 } from 'node:path'; const { basename, dirname, join } = win32;" : "$&");
  return import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { workBuddyElectron, workBuddyBundleEnvironment };').toString('base64')}`);
}

test('Windows discovers desktop bundles and wrappers in standard installation roots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbuddy-win-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir);
  const env = { ProgramFiles: join(root, 'Program Files'), 'ProgramFiles(x86)': join(root, 'Program Files (x86)'), LOCALAPPDATA: join(root, 'Local AppData'), PATH: '', CODEBUDDY_BIN: undefined, CODEBUDDY_CONFIG_DIR: undefined, WORKBUDDY_CONFIG_DIR: undefined, ACC_PRODUCT_CONFIG_PATH: undefined };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const setEnv = entries => { for (const [key, value] of Object.entries(entries)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  t.after(() => setEnv(previous));
  setEnv(env);
  const home = join(root, 'home');
  const { resolveCodeBuddyBinary, workBuddyBundleEnvironment } = await loadWindowsRunner(home);
  for (const [index, parent] of [env.ProgramFiles, env['ProgramFiles(x86)'], join(env.LOCALAPPDATA, 'Programs')].entries()) {
    const install = join(parent, 'WorkBuddy');
    const cli = join(install, 'resources', 'app.asar.unpacked', 'cli');
    const bundle = join(cli, 'dist', 'codebuddy-lite-wb.mjs');
    const wrapper = join(cli, 'bin', index === 1 ? 'codebuddy' : 'codebuddy.exe');
    await mkdir(dirname(wrapper), { recursive: true }); await writeFile(wrapper, 'fixture');
    assert.equal(await resolveCodeBuddyBinary(), wrapper);
    await mkdir(dirname(bundle), { recursive: true }); await writeFile(bundle, '// non-executable bundle');
    assert.equal(await resolveCodeBuddyBinary(), bundle);
    assert.equal(await resolveCodeBuddyBinary(wrapper), bundle);
    assert.deepEqual(await workBuddyBundleEnvironment(bundle), {
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
      CODEBUDDY_CONFIG_DIR: join(home, '.workbuddy'), WORKBUDDY_CONFIG_DIR: join(home, '.workbuddy'),
    });
    await rm(install, { recursive: true });
  }
});

test('Windows Electron path is the desktop executable for either CLI entry', async () => {
  const install = 'C:\\Program Files\\WorkBuddy';
  const { workBuddyElectron } = await loadWindowsRunner('C:\\Users\\Bob', true);
  for (const entry of ['dist\\codebuddy-lite-wb.mjs', 'bin\\codebuddy', 'bin\\codebuddy.exe']) {
    assert.equal(workBuddyElectron(win32.join(install, 'resources\\app.asar.unpacked\\cli', entry)), win32.join(install, 'WorkBuddy.exe'));
  }
});
