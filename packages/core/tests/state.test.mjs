import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileStore, ThreadMapStore, resolvePrivateConfigDir, findExecutable, IdleSleepGuard } from '../dist/index.js';
async function dir(t) {const p=await mkdtemp(join(tmpdir(),'nia-core-state-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('JsonFileStore serializes immutable snapshots with 0600 files and 0700 directory',async t=>{const d=await dir(t),store=new JsonFileStore(d,'state.json',v=>v);assert.deepEqual(await store.load({}),{});const a={n:1};const first=store.save(a);a.n=2;await first;assert.equal((await store.load({})).n,1);await Promise.all([store.save({n:3}),store.save({n:4})]);assert.equal((await store.load({})).n,4);assert.equal((await stat(join(d,'state.json'))).mode&0o777,0o600);assert.equal((await stat(d)).mode&0o777,0o700);});
test('JsonFileStore rejects traversal, symlink targets, directory aliases and public mode',async t=>{const d=await dir(t);assert.throws(()=>new JsonFileStore(d,'../state.json',v=>v),/basename/);await writeFile(join(d,'target'),'{}',{mode:0o600});await symlink(join(d,'target'),join(d,'state.json'));const store=new JsonFileStore(d,'state.json',v=>v);await assert.rejects(store.load({}),/private regular/);await assert.rejects(store.save({changed:true}),/Invalid state/);assert.equal(await readFile(join(d,'target'),'utf8'),'{}');await symlink(d,join(d,'alias'));await assert.rejects(resolvePrivateConfigDir(join(d,'alias')),/symbolic link/);await rm(join(d,'state.json'));await writeFile(join(d,'state.json'),'{}',{mode:0o644});await assert.rejects(store.load({}),/private regular/);});
test('ThreadMapStore validates and reloads session mappings',async t=>{const d=await dir(t),store=new ThreadMapStore(d);await store.load();await store.set('thread',{sessionId:'runtime-session',groupChatId:'group',updatedAt:'now'});const next=new ThreadMapStore(d);await next.load();assert.equal(next.get('thread').sessionId,'runtime-session');await writeFile(join(d,'threads.json'),'{"bad":{}}');await assert.rejects(new ThreadMapStore(d).load(),/Invalid thread mapping/);});
test('findExecutable explicit path does not silently fall back; sleep guard is best effort',async()=>{assert.equal(await findExecutable('node',process.execPath),await (await import('node:fs/promises')).realpath(process.execPath));await assert.rejects(findExecutable('node','/missing/explicit/node'),/Cannot find node/);const guard=new IdleSleepGuard();guard.setActive(true);guard.setActive(false);guard.close();});

test('findExecutable unwraps npm, pnpm and yarn Windows batch targets, not node.exe', async t => {
  const d = await dir(t);
  const { mkdir, realpath } = await import('node:fs/promises');
  const target = join(d, 'node_modules', 'some package', 'cli.js');
  await mkdir(join(d, 'node_modules', 'some package'), { recursive: true });
  await writeFile(target, '// entrypoint');
  await writeFile(join(d, 'node.exe'), 'interpreter');
  for (const prefix of ['%dp0%\\', '%~dp0\\', '%~dp0%\\', '%dp0%', '%~dp0']) {
    const shim = join(d, 'tool.cmd');
    await writeFile(shim, `@ECHO off\r\nIF EXIST "%dp0%\\node.exe" echo node\r\n"%_prog%" "${prefix}node_modules\\some package\\cli.js" %*\r\n`);
    assert.equal(await findExecutable('tool', shim, [], 'win32'), await realpath(target));
  }
  for (const extension of ['mjs', 'cjs', 'exe']) {
    const file = join(d, `cli.${extension}`);
    await writeFile(file, 'entrypoint');
    await writeFile(join(d, 'upper.CMD'), `"%~dp0/cli.${extension}" %*`);
    assert.equal(await findExecutable('tool', join(d, 'upper.CMD'), [], 'win32'), await realpath(file));
  }
});

test('findExecutable unwraps Windows npm shell shims and probes candidate suffixes', async t => {
  const d = await dir(t);
  const { realpath } = await import('node:fs/promises');
  const target = join(d, 'cli.js'); await writeFile(target, '// entrypoint');
  for (const shebang of ['#!/bin/sh', '#!/usr/bin/env sh']) {
    await writeFile(join(d, 'tool'), `${shebang}\nbasedir=...\nexec node "$basedir/cli.js" "$@"\n`);
    assert.equal(await findExecutable('tool', join(d, 'tool'), [], 'win32'), await realpath(target));
  }
  await writeFile(join(d, 'sibling'), '#!/bin/sh\nexec something');
  await writeFile(join(d, 'sibling.cmd'), '"%~dp0\\cli.js" %*');
  // Explicit extensionless input prefers its .cmd sibling on Windows.
  assert.equal(await findExecutable('tool', join(d, 'sibling'), [], 'win32'), await realpath(target));
  await writeFile(join(d, 'candidate.exe'), 'native');
  assert.equal(await findExecutable('not-on-path-987', undefined, [join(d, 'candidate')], 'win32'), await realpath(join(d, 'candidate.exe')));
  await writeFile(join(d, 'custom.bat'), '@echo custom');
  assert.equal(await findExecutable('tool', join(d, 'custom.bat'), [], 'win32'), await realpath(join(d, 'custom.bat')));
  await writeFile(join(d, 'missing.cmd'), '"%~dp0\\missing.js" %*');
  assert.equal(await findExecutable('tool', join(d, 'missing.cmd'), [], 'win32'), await realpath(join(d, 'missing.cmd')));
});

test('executableCommand uses Node for scripts and safe cmd plans for custom batch wrappers', async () => {
  const { executableCommand } = await import('../dist/index.js');
  for (const platform of ['win32', 'linux']) {
    for (const extension of ['js', 'mjs', 'cjs', 'JS']) {
      const plan = executableCommand(`a space/cli.${extension}`, ['a b', '& literal'], platform);
      assert.equal(plan.file, process.execPath);
      assert.deepEqual(plan.args, [`a space/cli.${extension}`, 'a b', '& literal']);
    }
    assert.equal(executableCommand('native.exe', [], platform).file, 'native.exe');
  }
  const plan = executableCommand('C:\\Program Files\\cli.cmd', ['app-server', 'a b'], 'win32');
  assert.deepEqual(plan.args, ['/d', '/s', '/c', '""C:\\Program Files\\cli.cmd" "app-server" "a b""']);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  for (const value of ['x&evil', '%PATH%', 'x!x', 'x"x', 'x\nx', 'x|x', '^x']) {
    assert.throws(() => executableCommand('cli.cmd', [value], 'win32'), /Unsafe batch/);
  }
});

test('--daemon detaches a Node child, strips flags and writes its private log', async t => {
  const d = await dir(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const entrypoint = join(d, 'launcher.mjs');
  const core = new URL('../dist/index.js', import.meta.url).href;
  const log = join(d, 'bridge.log');
  await writeFile(log, 'existing log\n', { mode: 0o644 });
  await chmod(log, 0o644);
  await writeFile(entrypoint, `import { maybeRespawnDaemon } from ${JSON.stringify(core)};
if (!await maybeRespawnDaemon(process.argv.slice(2), ${JSON.stringify(join(d, 'unused.log'))})) {
  console.log('child-args:' + JSON.stringify(process.argv.slice(2)));
  console.error('child-stderr');
  setTimeout(() => {}, 1400);
}`);
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid); } catch {} } });
  const { stdout } = await promisify(execFile)(process.execPath, [entrypoint, 'start', '--daemon', '--log-file', log, '--cwd', 'space path'], { timeout: 5000 });
  pid = Number(/pid (\d+)/.exec(stdout)?.[1]); assert.ok(pid);
  assert.match(stdout, /Started daemon/);
  const text = await readFile(log, 'utf8');
  assert.match(text, /^existing log\n/);
  assert.match(text, /child-stderr/);
  assert.match(text, /child-args:\["start","--cwd","space path"\]/);
  if (process.platform !== 'win32') assert.equal((await stat(log)).mode & 0o777, 0o600);
});

test('--daemon reports immediate failure and leaves diagnostics in the log', async t => {
  const d = await dir(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const entrypoint = join(d, 'failure.mjs'), log = join(d, 'failure.log');
  await writeFile(entrypoint, `import { maybeRespawnDaemon } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
if (!await maybeRespawnDaemon(process.argv.slice(2), ${JSON.stringify(log)})) { console.error('missing credentials'); process.exit(7); }`);
  await assert.rejects(promisify(execFile)(process.execPath, [entrypoint, 'start', '--daemon', '--log-file='+log]), /Daemon exited during startup/);
  assert.match(await readFile(log, 'utf8'), /missing credentials/);
  const { maybeRespawnDaemon } = await import('../dist/index.js');
  assert.equal(await maybeRespawnDaemon(['start'], log), false);
});

test('Windows PATH discovery prefers .exe then unwraps .cmd, using semicolon-separated directories', async t => {
  const d = await dir(t), { mkdir, realpath } = await import('node:fs/promises');
  const first = join(d, 'empty'), second = join(d, 'npm prefix');
  await mkdir(first); await mkdir(second);
  const target = join(second, 'cli.js'); await writeFile(target, '// target');
  await writeFile(join(second, 'unique-tool.cmd'), '"%~dp0\\cli.js" %*');
  const saved = process.env.PATH;
  process.env.PATH = `${first};${second}`;
  try {
    assert.equal(await findExecutable('unique-tool', undefined, [], 'win32'), await realpath(target));
    await writeFile(join(second, 'unique-tool.exe'), 'native');
    assert.equal(await findExecutable('unique-tool', undefined, [], 'win32'), await realpath(join(second, 'unique-tool.exe')));
  } finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
});

test('quoted batch and POSIX shim paths preserve spaces and unwrap to the actual target', async t => {
  const d = await dir(t);
  const { mkdir, realpath } = await import('node:fs/promises');
  await mkdir(join(d, 'some package'));
  const target = join(d, 'some package', 'cli.js');
  await writeFile(target, '// CLI');
  for (const quote of ['"', "'"]) {
    for (const prefix of ['%dp0%\\', '%~dp0\\', '%~dp0%\\', '$basedir/']) {
      const shell = prefix.startsWith('$');
      const shim = join(d, shell ? 'shell-tool' : 'batch-tool.cmd');
      await writeFile(shim, `${shell ? '#!/bin/sh\nexec node ' : '@echo off\r\nnode '}${quote}${prefix}some package/cli.js${quote} ${shell ? '"$@"' : '%*'}`);
      const actual = await findExecutable('tool', shim, [], 'win32');
      assert.equal(actual, await realpath(target));
      assert.notEqual(actual, shim);
    }
  }
  // Both forms still accept literal, unquoted targets without spaces.
  const plain = join(d, 'cli.js'); await writeFile(plain, '// CLI');
  for (const [filename, content] of [['plain.cmd', 'node %~dp0\\cli.js %*'], ['plain', '#!/bin/sh\nexec node $basedir/cli.js "$@"']]) {
    const shim = join(d, filename); await writeFile(shim, content);
    assert.equal(await findExecutable('tool', shim, [], 'win32'), await realpath(plain));
  }
});

test('--daemon rejects empty or flag-like --log-file values before touching the filesystem', async t => {
  const d = await dir(t), log = join(d, 'not-created', 'daemon.log');
  const { maybeRespawnDaemon } = await import('../dist/index.js');
  for (const flags of [['--log-file='], ['--log-file'], ['--log-file', ''], ['--log-file', '--cwd'], ['--log-file', '-x']]) {
    await assert.rejects(maybeRespawnDaemon(['start', '--daemon', ...flags], log), { message: '--log-file requires a path' });
  }
  await assert.rejects(stat(join(d, 'not-created')), { code: 'ENOENT' });
});

test('--daemon refuses symlink, dangling symlink and directory log destinations', async t => {
  const d = await dir(t), target = join(d, 'target.log');
  const { maybeRespawnDaemon } = await import('../dist/index.js');
  await writeFile(target, 'untouched', { mode: 0o644 });
  const link = join(d, 'link.log'), dangling = join(d, 'dangling.log');
  await symlink(target, link); await symlink(join(d, 'absent.log'), dangling);
  for (const log of [link, dangling, d]) {
    await assert.rejects(maybeRespawnDaemon(['start', '--daemon'], log), /Refusing to write daemon logs to a symlink or non-regular file/);
  }
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  await assert.rejects(stat(join(d, 'absent.log')), { code: 'ENOENT' });
});
