import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const driver = fileURLToPath(new URL('../../../tests/fixtures/mock-doubao.mjs', import.meta.url));
export const nativeBinary = fileURLToPath(new URL('../../../tests/fixtures/mock-doubao-native.mjs', import.meta.url));
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// Only OS/app discovery and subprocess observation are mocked. Driver/native
// execution, real filesystem discovery, readiness and host lifecycle remain real.
export async function loadRunner(os = 'darwin', exists = true, spawns) {
  const spawnKey = 'doubao_native_spawn_observer';
  if (spawns) globalThis[spawnKey] = spawns;
  const native = (await readFile(new URL('../dist/native.js', import.meta.url), 'utf8'))
    .replace("from '@nia-teams/agent-bridge-core'", `from ${JSON.stringify(new URL('../../core/dist/index.js', import.meta.url).href)}`)
    .replace("import { execFile, spawn } from 'node:child_process';", `import { execFile, spawn as actualSpawn } from 'node:child_process';
      const spawn = (binary, args, options) => { globalThis[${JSON.stringify(spawnKey)}]?.push({ binary, args, options }); return actualSpawn(binary, args, options); };`);
  const require = createRequire(import.meta.url);
  const workerFile = join(dirname(process.env.NIA_MOCK_LOG), 'headless-worker.mjs');
  const worker = (await readFile(new URL('../dist/headless-worker.js', import.meta.url), 'utf8'))
    .replace("driverRequire.resolve('doubao-cli/src/cli.mjs')", JSON.stringify(require.resolve('doubao-cli/src/cli.mjs')))
    .replace("driverRequire.resolve('doubao-cli/src/headless.mjs')", JSON.stringify(fileURLToPath(new URL('../../../tests/fixtures/mock-doubao-headless.mjs', import.meta.url))))
    .replace("driverRequire.resolve('doubao-cli/src/app.mjs')", JSON.stringify(require.resolve('doubao-cli/src/app.mjs')))
    .replace('options.onAccepted =', "options.__args = ['--platform', 'headless', '--json', ...request.args]; options.onAccepted =");
  await writeFile(workerFile, worker);
  const source = (await readFile(new URL('../dist/runner.js', import.meta.url), 'utf8'))
    .replace("fileURLToPath(new URL('./headless-worker.js', import.meta.url))", JSON.stringify(workerFile))
    .replace("from './desktop-auth.js'", `from ${JSON.stringify(new URL('../dist/desktop-auth.js', import.meta.url).href)}`)
    .replace("from './native.js'", `from ${JSON.stringify(data(native))}`)
    .replace("import { platform } from 'node:os';", `const platform = () => ${JSON.stringify(os)};`)
    .replace("import { existsSync } from 'node:fs';", `const existsSync = () => ${exists};`)
    .replace("createRequire(import.meta.url).resolve('doubao-cli/bin/doubao.mjs')", JSON.stringify(driver));
  return (await import(data(source))).createDoubaoRunner;
}

export async function cdpFixture(t, backend = 'work') {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const scheme = backend === 'work' ? 'doubaowork' : 'doubao';
  const state = { requests: [], cookies: [{ name: 'sessionid', value: 'test-cookie-one', domain: '.doubao.com', expires: -1 }], login: false, wrongApp: false, wsError: false, httpError: false };
  const ws = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.url !== '/json/list' || state.httpError) { res.statusCode = 503; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', url: `${state.wrongApp ? 'unrelated' : scheme}://${scheme}-chat/chat/`, webSocketDebuggerUrl: state.endpoint.replace('http:', 'ws:') + '/devtools/page/1' },
      ...(state.login ? [{ type: 'page', url: `${state.loginScheme || scheme}://${scheme}-login/login` }] : [])]));
  });
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, connection => ws.emit('connection', connection)));
  ws.on('connection', connection => connection.on('message', raw => {
    const message = JSON.parse(raw); state.requests.push(message);
    connection.send(JSON.stringify(state.wsError ? { id: message.id, error: { message: 'secret-cookie-do-not-leak' } } : { id: message.id, result: { cookies: state.cookies } }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const connection of ws.clients) connection.terminate(); ws.close(); await new Promise(resolve => server.close(resolve)); });
  return state;
}
