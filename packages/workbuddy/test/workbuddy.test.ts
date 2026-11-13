import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, readFile, readdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';

// This workspace targets Node 20; the test entrypoint transpiles this file in memory.
const require = createRequire(join(process.cwd(), 'package.json'));
const { build } = require('esbuild');

test('WorkBuddy runner passes bundle and configuration overrides to SDK query', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workbuddy-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keys = ['CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR', 'ACC_PRODUCT_CONFIG_PATH', 'CODEBUDDY_FORCE_LITE_WB_BUNDLE', 'CODEBUDDY_FORCE_HEADLESS_BUNDLE', 'CODEBUDDY_AUTH_TOKEN', 'ACC_USER_ID', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LOCALAPPDATA'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  for (const key of keys) delete process.env[key];
  async function loadRunner(platformName = 'darwin') {
    const bundled = await build({
      entryPoints: [join(process.cwd(), 'src/runner.ts')], bundle: true, write: false,
      platform: 'node', format: 'esm', plugins: [{
        name: 'mock-sdk-boundary',
        setup(build) {
          const modules = {
            '@tencent-ai/agent-sdk': `export const query = input => input; export const tool = () => ({}); export const createSdkMcpServer = () => ({ instance: { close: async () => {} } });`,
            '@nia-teams/agent-bridge-core': `export const findExecutable = async (_, explicit) => explicit; export const consumeSdkQuery = input => input; export const GROUP_CHAT_INSTRUCTIONS = '';`,
            'node:os': `export const homedir = () => ${JSON.stringify(home)}; export const platform = () => ${JSON.stringify(platformName)};`,
          };
          build.onResolve({ filter: /^(@tencent-ai\/agent-sdk|@nia-teams\/agent-bridge-core|node:os)$/ }, args => ({ path: args.path, namespace: 'mock' }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: modules[args.path], loader: 'js' }));
        },
      }],
    });
    return (await import(`data:text/javascript;base64,${Buffer.from((bundled.outputFiles[0].text + '\n//# sourceURL=workbuddy-runner-test.js')).toString('base64')}`)).createWorkBuddyRunner;
  }
  const createWorkBuddyRunner = await loadRunner();
  const appBinary = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
  const defaultDir = join(home, '.workbuddy');
  async function invoke(binary = appBinary, signal = new AbortController().signal) {
    return createWorkBuddyRunner({ cwd: home, codebuddyBin: binary })({
      prompt: 'hello', signal,
      send: async () => {}, history: async () => [], permission: async () => ({ behavior: 'allow' }),
    });
  }
  function expected(configDir) {
    return { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1', CODEBUDDY_CONFIG_DIR: configDir, WORKBUDDY_CONFIG_DIR: configDir };
  }
  await t.test('ordinary CLI without ~/.workbuddy retains SDK environment defaults', async () => {
    assert.equal((await invoke('/usr/local/bin/codebuddy')).options.env, undefined);
  });
  await t.test('app binary forces lite/headless bundles even without a config cache', async () => {
    const result = await invoke();
    assert.equal(result.prompt, 'hello');
    assert.equal(result.options.pathToCodebuddyCode, appBinary);
    assert.deepEqual(result.options.env, expected(defaultDir));
    assert.equal(process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, undefined);
    assert.equal(process.env.CODEBUDDY_CONFIG_DIR, undefined);
  });
  await t.test('existing ~/.workbuddy enables overrides for an ordinary binary', async () => {
    await mkdir(defaultDir);
    assert.deepEqual((await invoke('/usr/local/bin/codebuddy')).options.env, expected(defaultDir));
  });
  await t.test('WORKBUDDY_CONFIG_DIR supplies both SDK config variables', async () => {
    process.env.WORKBUDDY_CONFIG_DIR = join(home, 'workbuddy-config');
    assert.deepEqual((await invoke()).options.env, expected(process.env.WORKBUDDY_CONFIG_DIR));
  });
  await t.test('CODEBUDDY_CONFIG_DIR takes precedence and newest matching cache file wins', async () => {
    const configDir = process.env.CODEBUDDY_CONFIG_DIR = join(home, 'codebuddy-config');
    const cache = join(configDir, 'cache');
    await mkdir(cache, { recursive: true });
    const older = join(cache, 'acc-product-config-v3-z.json');
    const newest = join(cache, 'acc-product-config-v3-a.json');
    await writeFile(older, '{}'); await utimes(older, 100, 100);
    await writeFile(newest, '{}'); await utimes(newest, 200, 200);
    await writeFile(join(cache, 'acc-product-config-v2-newer.json'), '{}');
    await writeFile(join(cache, 'acc-product-config-v3-newer.json.bak'), '{}');
    await mkdir(join(cache, 'acc-product-config-v3-directory.json'));
    assert.deepEqual((await invoke()).options.env, { ...expected(configDir), ACC_PRODUCT_CONFIG_PATH: newest });
    assert.equal(process.env.ACC_PRODUCT_CONFIG_PATH, undefined);
  });
  await t.test('explicit ACC_PRODUCT_CONFIG_PATH is inherited, not replaced by discovery', async () => {
    process.env.ACC_PRODUCT_CONFIG_PATH = '/explicit/product.json';
    const env = (await invoke()).options.env;
    assert.deepEqual(env, expected(process.env.CODEBUDDY_CONFIG_DIR));
    assert.equal({ ...process.env, ...env }.ACC_PRODUCT_CONFIG_PATH, '/explicit/product.json');
  });
  await t.test('empty cache and cache with no matching files leave product config unset', async () => {
    delete process.env.ACC_PRODUCT_CONFIG_PATH;
    const configDir = process.env.CODEBUDDY_CONFIG_DIR = join(home, 'empty-config');
    await mkdir(join(configDir, 'cache'), { recursive: true });
    assert.deepEqual((await invoke()).options.env, expected(configDir));
    await writeFile(join(configDir, 'cache', 'unrelated.json'), '{}');
    assert.deepEqual((await invoke()).options.env, expected(configDir));
  });
  const authDir = join(home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth');
  const infoPath = join(authDir, 'workbuddy-desktop.info');
  await mkdir(authDir, { recursive: true });
  await t.test('plain desktop accessToken and account uid are passed only to the child env', async () => {
    const desktopToken = randomBytes(24).toString('hex');
    await writeFile(infoPath, JSON.stringify({ auth: { accessToken: desktopToken }, account: { uid: 'desktop-user' } }));
    const env = (await invoke()).options.env;
    assert.equal(env.CODEBUDDY_AUTH_TOKEN, desktopToken);
    assert.equal(env.ACC_USER_ID, 'desktop-user');
    assert.equal(process.env.CODEBUDDY_AUTH_TOKEN, undefined);
    assert.equal(process.env.ACC_USER_ID, undefined);
  });
  await t.test('explicit token bypasses desktop lookup and explicit uid is preserved', async () => {
    const explicitToken = randomBytes(24).toString('hex');
    process.env.CODEBUDDY_AUTH_TOKEN = explicitToken;
    await writeFile(infoPath, 'not JSON');
    const env = (await invoke()).options.env;
    assert.equal(env.CODEBUDDY_AUTH_TOKEN, undefined);
    assert.equal({ ...process.env, ...env }.CODEBUDDY_AUTH_TOKEN, explicitToken);
    delete process.env.CODEBUDDY_AUTH_TOKEN;
    await writeFile(infoPath, JSON.stringify({ auth: { accessToken: 'plain' }, account: { uid: 'desktop-user' } }));
    process.env.ACC_USER_ID = 'explicit-user';
    assert.equal((await invoke()).options.env.ACC_USER_ID, undefined);
    delete process.env.ACC_USER_ID;
  });
  await t.test('other .info files are considered but preferred desktop credentials win', async () => {
    const otherToken = randomBytes(24).toString('hex');
    await writeFile(join(authDir, 'other.info'), JSON.stringify({ auth: { accessToken: otherToken }, account: { uid: 42 } }));
    assert.equal((await invoke()).options.env.CODEBUDDY_AUTH_TOKEN, 'plain');
    await writeFile(infoPath, '{}');
    assert.equal((await invoke()).options.env.CODEBUDDY_AUTH_TOKEN, otherToken);
    assert.equal((await invoke()).options.env.ACC_USER_ID, '42');
    await writeFile(join(authDir, 'other.info'), '{broken');
    assert.equal((await invoke()).options.env.CODEBUDDY_AUTH_TOKEN, undefined);
  });
  await t.test('desktop auth lookup uses Windows and Linux application data directories', async () => {
    for (const platformName of ['win32', 'linux']) {
      process.env.LOCALAPPDATA = join(home, 'local-app-data');
      const dir = platformName === 'win32'
        ? join(process.env.LOCALAPPDATA, 'CodeBuddyExtension/Data/Public/auth')
        : join(home, '.local/share/CodeBuddyExtension/Data/Public/auth');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'login.info'), JSON.stringify({ auth: { accessToken: platformName + '-token' } }));
      const runner = await loadRunner(platformName);
      const result = await runner({ cwd: home, codebuddyBin: appBinary })({ prompt: 'hi', signal: new AbortController().signal });
      assert.equal(result.options.env.CODEBUDDY_AUTH_TOKEN, platformName + '-token');
    }
    delete process.env.LOCALAPPDATA;
  });
  await t.test('encrypted desktop token uses exact AAD, caches concurrently, and refreshes on mtime change', { skip: process.platform === 'win32' }, async () => {
    const app = join(home, 'App With Spaces', 'WorkBuddy.app');
    const binary = join(app, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy');
    const electron = join(app, 'Contents/MacOS/Electron');
    const bootstrap = join(home, 'mock-electron.cjs');
    const log = join(home, 'mock-electron-log.jsonl');
    const secret = randomBytes(32).toString('hex');
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    const lite = join(app, 'Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs');
    await mkdir(join(lite, '..'), { recursive: true });
    await writeFile(lite, '// readable ESM bundle; no executable bit required');
    await writeFile(bootstrap, `
      const fs = require('node:fs');
      const [flag, script, authFilePath, ...extra] = process.argv.slice(2);
      if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(3);
      if (process.env.NODE_OPTIONS !== '') process.exit(4);
      if (flag !== '-e' || typeof script !== 'string' || extra.length || authFilePath !== ${JSON.stringify(infoPath)}) process.exit(5);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ flag, script, authFilePath, runAsNode: process.env.ELECTRON_RUN_AS_NODE, nodeOptions: process.env.NODE_OPTIONS }) + '\\n');
      process._linkedBinding = name => {
        if (name !== 'electron_browser_workbuddy_storage') throw new Error();
        return { loggerGet: () => JSON.stringify({ atRestSecretKey: ${JSON.stringify(secret)} }) };
      };
      // Match Node's -e argv layout without writing the inline script to disk.
      process.argv = [process.execPath, authFilePath];
      require('node:vm').runInNewContext(script, { require, process, Buffer }, { filename: 'mock-electron-inline.cjs' });
    `);
    const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    await writeFile(electron, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(bootstrap)} "$@"\n`);
    await chmod(electron, 0o700);
    function encrypted(token) {
      const key = createHash('sha256').update(secret, 'utf8').digest();
      const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
      const uint32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
      const lp = value => Buffer.concat([uint32(Buffer.byteLength(value)), Buffer.from(value)]);
      const suite = 1, nonce = randomBytes(12);
      const aad = Buffer.concat([Buffer.from('WB-AAD\0'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), uint32(suite), lp(keyId), Buffer.from([2, 0, 0])]);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({ suite, nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })).toString('base64') };
    }
    const save = async (wrapper, mtime) => {
      await writeFile(infoPath, JSON.stringify({ auth: { accessToken: wrapper }, account: { uid: 'encrypted-user' } }));
      await utimes(infoPath, mtime, mtime);
    };
    const count = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    // A hostile host preload and a false NodeMain flag must be overridden in the child.
    process.env.ELECTRON_RUN_AS_NODE = '0';
    process.env.NODE_OPTIONS = '--require /nonexistent/host-preload.cjs';
    const before = (await readdir(home)).sort();
    await save(encrypted('decrypted-token-one'), 1000);
    const results = await Promise.all([invoke(binary), invoke(binary)]);
    for (const result of results) {
      assert.equal(result.options.pathToCodebuddyCode, lite);
      assert.equal(result.options.env.CODEBUDDY_AUTH_TOKEN, 'decrypted-token-one');
      assert.equal(result.options.env.ACC_USER_ID, 'encrypted-user');
    }
    await invoke(binary);
    assert.equal((await count()).length, 1);
    await save(encrypted('decrypted-token-two'), 2000);
    assert.equal((await invoke(binary)).options.env.CODEBUDDY_AUTH_TOKEN, 'decrypted-token-two');
    assert.equal((await count()).length, 2);
    for (const entry of await count()) {
      assert.equal(entry.flag, '-e');
      assert.equal(entry.runAsNode, '1');
      assert.equal(entry.nodeOptions, '');
      assert.equal(entry.authFilePath, infoPath);
      assert.match(entry.script, /readFileSync\(process.argv\[1\]/);
      assert.doesNotMatch(entry.script, /decrypted-token|mkdtemp|writeFile|--require/);
      assert.doesNotMatch(entry.script, new RegExp(secret));
    }
    // Failed authentication must not be cached or expose any secret/output.
    const invalid = encrypted('do-not-leak');
    const envelope = JSON.parse(Buffer.from(invalid.envelope, 'base64').toString());
    envelope.authTag = Buffer.alloc(16).toString('base64');
    invalid.envelope = Buffer.from(JSON.stringify(envelope)).toString('base64');
    await save(invalid, 3000);
    for (let i = 0; i < 2; i++) await assert.rejects(invoke(binary), error => {
      assert.match(error.message, /Unable to decrypt WorkBuddy desktop credentials/);
      assert.doesNotMatch(String(error.stack), /do-not-leak/);
      assert.doesNotMatch(String(error.stack), new RegExp(secret));
      return true;
    });
    assert.equal((await count()).length, 4);
    // No temporary script/output files are created (only the mock's instrumentation log).
    assert.deepEqual((await readdir(home)).filter(name => name !== 'mock-electron-log.jsonl').sort(), before);
    assert.equal(process.env.NODE_OPTIONS, '--require /nonexistent/host-preload.cjs');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '0');
    // Captured child output/errors must never be attached as an error cause or properties.
    const failedChildToken = randomBytes(24).toString('hex');
    for (const [output, exitCode, expected] of [
      [failedChildToken, 0, /returned no token/],
      [JSON.stringify({ token: '' }), 0, /returned no token/],
      [JSON.stringify({ token: failedChildToken }), 9, /Unable to decrypt/],
    ]) {
      await writeFile(bootstrap, `process.stdout.write(${JSON.stringify(output)}); process.stderr.write('secret-stderr-do-not-leak'); process.exit(${exitCode});`);
      await assert.rejects(invoke(binary), error => {
        assert.match(error.message, expected);
        assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /secret-stderr-do-not-leak/);
        assert.doesNotMatch(String(error.stack) + JSON.stringify(error), new RegExp(secret));
        assert.doesNotMatch(String(error.stack) + JSON.stringify(error), new RegExp(failedChildToken));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.equal(process.env.CODEBUDDY_AUTH_TOKEN, undefined);
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.NODE_OPTIONS;
  });
});

test('real agent-sdk spawns WorkBuddy desktop ESM and standard CLI installations', { timeout: 30_000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbuddy-real-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createWorkBuddyRunner, resolveCodeBuddyBinary } = await import(pathToFileURL(join(process.cwd(), 'dist/runner.js')).href);
  const keys = ['PATH', 'HOME', 'CODEBUDDY_BIN', 'CODEBUDDY_AUTH_TOKEN', 'NIA_MOCK_LOG', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR', 'ACC_PRODUCT_CONFIG_PATH'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const explicitToken = randomBytes(24).toString('hex');
  process.env.CODEBUDDY_AUTH_TOKEN = explicitToken;
  delete process.env.CODEBUDDY_BIN;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  process.env.CODEBUDDY_CONFIG_DIR = join(root, 'config');
  delete process.env.WORKBUDDY_CONFIG_DIR;
  const cache = join(root, 'config/cache');
  await mkdir(cache, { recursive: true });
  const product = join(cache, 'acc-product-config-v3-test.json');
  await writeFile(product, '{}');
  const log = process.env.NIA_MOCK_LOG = join(root, 'cli.jsonl');
  const app = join(root, 'App With Spaces/WorkBuddy.app');
  const cli = join(app, 'Contents/Resources/app.asar.unpacked/cli');
  const binary = join(cli, 'bin/codebuddy');
  const lite = join(cli, 'dist/codebuddy-lite-wb.mjs');
  await mkdir(join(cli, 'bin'), { recursive: true });
  await mkdir(join(cli, 'dist/lazy-lite-wb'), { recursive: true });
  // This CJS wrapper must never be executed, nor rewritten to a nonexistent headless.js.
  await writeFile(binary, '#!/usr/bin/env node\nthrow new Error("SDK executed desktop wrapper");\n');
  await chmod(binary, 0o755);
  const fixture = (await readFile(join(process.cwd(), '../../tests/fixtures/mock-sdk-cli.mjs'), 'utf8'))
    .replace("log({ kind: 'spawn', args });", `log({ kind: 'spawn', args, entry: process.argv[1], cwd: process.cwd(), env: Object.fromEntries(['PATH', 'HOME', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR', 'ACC_PRODUCT_CONFIG_PATH', 'CODEBUDDY_FORCE_LITE_WB_BUNDLE', 'CODEBUDDY_FORCE_HEADLESS_BUNDLE'].map(key => [key, process.env[key]])) });`);
  await writeFile(lite, fixture, { mode: 0o644 });
  const entries = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const invoke = async (selected, extra = {}, overrides = {}) => {
    const sessions = [], sends = [], permissions = [];
    const result = await createWorkBuddyRunner({ cwd: root, codebuddyBin: selected, ...extra })({
      prompt: 'hello', signal: new AbortController().signal,
      session: async id => { sessions.push(id); }, activity: async () => {},
      send: async text => { sends.push(text); }, history: async () => [{ content: 'older message' }],
      permission: async (name, input) => { permissions.push({ name, input }); return { behavior: 'allow', updatedInput: { ...input, command: 'pwd' } }; },
      ...overrides,
    });
    return { result, sessions, sends, permissions, spawn: (await entries()).filter(e => e.kind === 'spawn').at(-1) };
  };
  await t.test('desktop wrapper selects readable ESM, preserves parent env and adds desktop config', async () => {
    assert.equal(await resolveCodeBuddyBinary(binary), lite);
    const turn = await invoke(binary);
    assert.deepEqual(turn.result, { text: 'SDK final reply' });
    assert.ok(turn.sessions[0]);
    assert.equal(turn.spawn.entry, lite);
    assert.equal(turn.spawn.cwd, root);
    assert.equal(turn.spawn.env.PATH, process.env.PATH);
    assert.equal(turn.spawn.env.HOME, process.env.HOME);
    assert.equal(turn.spawn.env.CODEBUDDY_AUTH_TOKEN, explicitToken);
    assert.equal(turn.spawn.env.CODEBUDDY_CONFIG_DIR, join(root, 'config'));
    assert.equal(turn.spawn.env.WORKBUDDY_CONFIG_DIR, join(root, 'config'));
    assert.equal(turn.spawn.env.ACC_PRODUCT_CONFIG_PATH, product);
    assert.equal(turn.spawn.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1');
    assert.equal(turn.spawn.env.CODEBUDDY_FORCE_HEADLESS_BUNDLE, '1');
    assert.ok(turn.spawn.args.includes('--input-format=stream-json'));
    assert.ok(turn.spawn.args.includes('--output-format=stream-json'));
    assert.ok(turn.spawn.args.includes('user,project,local'));
    assert.deepEqual((await readdir(join(cli, 'dist'))).sort(), ['codebuddy-lite-wb.mjs', 'lazy-lite-wb']);
  });
  await t.test('direct non-executable .mjs and CODEBUDDY_BIN use the same SDK entrypoint', async () => {
    assert.equal((await invoke(lite)).spawn.entry, lite);
    process.env.CODEBUDDY_BIN = binary;
    assert.equal((await invoke(undefined)).spawn.entry, lite);
    delete process.env.CODEBUDDY_BIN;
  });
  await t.test('PATH symlink resolves the desktop distribution before SDK rewriting', async () => {
    const binDir = join(root, 'path-bin'); await mkdir(binDir);
    await symlink(binary, join(binDir, 'codebuddy'));
    const path = process.env.PATH;
    process.env.PATH = binDir + delimiter + path;
    try { assert.equal((await invoke(undefined)).spawn.entry, lite); }
    finally { process.env.PATH = path; }
  });
  await t.test('desktop MCP, permission updated input, system prompt, resume and full-auto survive real SDK protocol', async () => {
    const first = await invoke(binary, {}, { prompt: 'permission tools' });
    assert.deepEqual(first.sends, ['SDK interim']);
    assert.equal(first.permissions[0].name, 'Bash');
    const records = await entries();
    assert.ok(records.some(e => e.kind === 'permission' && e.result.allowed && e.result.updatedInput.command === 'pwd'));
    assert.ok(records.some(e => e.kind === 'history' && JSON.stringify(e.result).includes('older message')));
    const init = records.find(e => e.kind === 'in' && e.message.request?.subtype === 'initialize').message.request;
    assert.deepEqual(init.sdkMcpServers, ['nia']);
    assert.match(init.appendSystemPrompt, /GroupChat/);
    const resumed = await invoke(binary, { fullAuto: true }, { resume: first.sessions[0] });
    assert.equal(resumed.sessions[0], first.sessions[0]);
    assert.equal(resumed.spawn.args[resumed.spawn.args.indexOf('--resume') + 1], first.sessions[0]);
    assert.equal(resumed.spawn.args[resumed.spawn.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  });
  await t.test('standard bin/codebuddy still uses its installed headless bundle', async () => {
    const standard = join(root, 'standard');
    await mkdir(join(standard, 'bin'), { recursive: true });
    await mkdir(join(standard, 'dist'));
    await writeFile(join(standard, 'package.json'), '{"type":"module"}');
    await writeFile(join(standard, 'bin/codebuddy'), '#!/usr/bin/env node\n', { mode: 0o755 });
    const headless = join(standard, 'dist/codebuddy-headless.js');
    await writeFile(headless, fixture);
    const selected = join(standard, 'bin/codebuddy');
    assert.equal(await resolveCodeBuddyBinary(selected), selected);
    assert.equal((await invoke(selected)).spawn.entry, headless);
    assert.equal((await invoke(headless)).spawn.entry, headless);
  });
  await t.test('desktop startup failures reach logs/activity without a false final, and the next turn recovers', async t => {
    await writeFile(lite, 'process.stderr.write("mock desktop startup failed\\n"); process.exit(7);');
    await assert.rejects(invoke(binary), /mock desktop startup failed|exited with code 7|stdout closed unexpectedly/);
    const { fixture: bridgeFixture, until, message } = await import(pathToFileURL(join(process.cwd(), '../core/tests/helpers.mjs')).href);
    const { BridgeClient, SessionHost } = await import(pathToFileURL(join(process.cwd(), '../core/dist/index.js')).href);
    const f = await bridgeFixture(t), errors = [];
    const bridge = new BridgeClient(f.credentials);
    const host = new SessionHost(bridge, createWorkBuddyRunner({ cwd: root, codebuddyBin: binary }), {
      configDir: f.dir, runtime: 'WorkBuddy', approvalTool: 'workbuddy.approval', onError: error => errors.push(error),
    });
    t.after(async () => { await host.close(); bridge.close(); });
    await host.start(); await bridge.start();
    host.message(message('broken desktop'));
    await until(() => f.rpcs.some(r => r.method === 'thread.activity' && r.params.state === 'idle' && r.params.errorMessage), 'desktop failure activity');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /CLI process/);
    assert.equal(f.rpcs.filter(r => r.method === 'group_chat.send_message').length, 0);
    await writeFile(lite, fixture);
    host.message(message('try again'));
    await until(() => f.rpcs.some(r => r.method === 'group_chat.send_message'), 'desktop recovery final');
    assert.equal(f.rpcs.find(r => r.method === 'group_chat.send_message').params.content, 'SDK final reply');
  });
});
