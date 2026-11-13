import { query, createSdkMcpServer, tool, type Options } from '@tencent-ai/agent-sdk';
import { z } from 'zod';
import { consumeSdkQuery, GROUP_CHAT_INSTRUCTIONS, findExecutable, type TurnRunner } from '@nia-teams/agent-bridge-core';
import { homedir, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
export interface WorkBuddyOptions { cwd: string; model?: string; fullAuto?: boolean; codebuddyBin?: string }
export async function resolveCodeBuddyBinary(explicit?: string): Promise<string> {
  const selected = explicit ?? process.env.CODEBUDDY_BIN;
  // SDK scripts are read by Node, not executed by the OS; dist/*.mjs need no +x.
  if (selected && /\.(?:mjs|cjs|js)$/i.test(selected)) {
    const script = await realpath(selected);
    await access(script, constants.R_OK);
    if (!(await stat(script)).isFile()) throw new Error(`CodeBuddy script is not a file: ${script}`);
    return script;
  }
  const binary = await findExecutable('codebuddy', selected, [
    '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    join(homedir(), 'Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy.exe')] : []),
    '/opt/homebrew/bin/codebuddy', '/usr/local/bin/codebuddy',
  ]);
  if (/\.(?:cmd|bat)$/i.test(binary)) throw new Error('CodeBuddy SDK cannot run a custom batch wrapper; pass --codebuddy-bin with the underlying .js, .mjs, .cjs, or .exe entrypoint');
  // agent-sdk unconditionally rewrites bin/codebuddy to dist/codebuddy-headless.js.
  // Desktop WorkBuddy ships only this ESM bundle. Select its real entrypoint before
  // handing the path to the SDK, including when discovery followed a PATH symlink.
  if (basename(binary) === 'codebuddy' && basename(dirname(binary)) === 'bin') {
    const lite = join(dirname(binary), '../dist/codebuddy-lite-wb.mjs');
    try {
      if (!(await stat(lite)).isFile()) throw new Error(`CodeBuddy bundle is not a file: ${lite}`);
      await access(lite, constants.R_OK);
      return await realpath(lite);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return binary;
}
async function workBuddyBundleEnvironment(binary: string): Promise<Options['env']> {
  const defaultConfigDir = join(homedir(), '.workbuddy');
  if (!binary.includes('WorkBuddy.app') && !existsSync(defaultConfigDir)) return undefined;
  const configDir = process.env.CODEBUDDY_CONFIG_DIR || process.env.WORKBUDDY_CONFIG_DIR || defaultConfigDir;
  const env: NonNullable<Options['env']> = {
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    CODEBUDDY_CONFIG_DIR: configDir,
    WORKBUDDY_CONFIG_DIR: configDir,
  };
  if (!process.env.ACC_PRODUCT_CONFIG_PATH) {
    const cacheDir = join(configDir, 'cache');
    const entries = await readdir(cacheDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const configs = await Promise.all(entries
      .filter(entry => entry.isFile() && /^acc-product-config-v3-.*\.json$/.test(entry.name))
      .map(async entry => {
        const path = join(cacheDir, entry.name);
        return { path, mtime: (await stat(path)).mtimeMs };
      }));
    configs.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    if (configs[0]) env.ACC_PRODUCT_CONFIG_PATH = configs[0].path;
  }
  return env;
}
// Electron NodeMain exposes the storage binding without starting the desktop UI.
// Only the existing credential file path is passed in argv; keys/tokens stay in memory.
const decryptDesktopTokenScript = String.raw`
const crypto = require('node:crypto');
try {
  const rawKey = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (typeof rawKey.atRestSecretKey !== 'string' || !rawKey.atRestSecretKey) throw new Error();
  const key = crypto.createHash('sha256').update(rawKey.atRestSecretKey, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const doc = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
  const accessToken = doc?.auth?.accessToken;
  if (accessToken?.$wbEncrypted !== 1 || typeof accessToken.envelope !== 'string') throw new Error();
  const env = JSON.parse(Buffer.from(accessToken.envelope, 'base64').toString('utf8'));
  function encodeUint32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v, 0); return b; }
  function encodeLP(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([encodeUint32(b.length), b]); }
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), encodeLP('WBEV1'), encodeLP('sym-v1'),
    encodeUint32(env.suite), encodeLP(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ]);
  const nonce = Buffer.from(env.nonce, 'base64'), tag = Buffer.from(env.authTag, 'base64');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad); decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  if (!token.trim()) throw new Error();
  process.stdout.write(JSON.stringify({ token }) + '\n', () => process.exit(0));
} catch { process.exit(1); }
`;
const desktopTokenCache = new Map<string, { mtimeMs: number; token: Promise<string> }>();

function desktopAuthDirectory(): string | undefined {
  switch (platform()) {
    case 'darwin': return join(homedir(), 'Library/Application Support/CodeBuddyExtension/Data/Public/auth');
    case 'win32': return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CodeBuddyExtension/Data/Public/auth') : undefined;
    default: return join(homedir(), '.local/share/CodeBuddyExtension/Data/Public/auth');
  }
}
function workBuddyElectron(binary: string): string {
  const app = binary.indexOf('WorkBuddy.app');
  if (app !== -1) {
    const electron = join(binary.slice(0, app + 'WorkBuddy.app'.length), 'Contents/MacOS/Electron');
    if (existsSync(electron)) return electron;
  }
  if (platform() === 'darwin') return '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
  // resources/app.asar.unpacked/cli/bin/codebuddy is inside the desktop install.
  return join(dirname(binary), '../../../..', platform() === 'win32' ? 'WorkBuddy.exe' : 'workbuddy');
}
async function decryptDesktopToken(binary: string, authFilePath: string, signal: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };
  return new Promise<string>((resolve, reject) => {
    const child = execFile(workBuddyElectron(binary), ['-e', decryptDesktopTokenScript, authFilePath], { env, signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      // execFile errors include captured output: do not propagate them or their cause.
      if (error) { reject(new Error('Unable to decrypt WorkBuddy desktop credentials; log in to WorkBuddy or set CODEBUDDY_AUTH_TOKEN')); return; }
      try {
        const result = JSON.parse(stdout);
        if (typeof result.token !== 'string' || !result.token.trim()) throw new Error();
        resolve(result.token);
      } catch { reject(new Error('WorkBuddy desktop credential decryption returned no token')); }
    });
    child.stdin?.end();
  });
}
async function workBuddyEnvironment(binary: string, signal: AbortSignal): Promise<Options['env']> {
  const env = await workBuddyBundleEnvironment(binary);
  if (process.env.CODEBUDDY_AUTH_TOKEN) return env;
  const authDir = desktopAuthDirectory();
  if (!authDir) return env;
  const files = await readdir(authDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw new Error('Unable to read WorkBuddy desktop auth directory');
  });
  const names = files.filter(file => file.isFile() && file.name.endsWith('.info')).map(file => file.name)
    .sort((a, b) => Number(b === 'workbuddy-desktop.info') - Number(a === 'workbuddy-desktop.info') || a.localeCompare(b));
  for (const name of names) {
    signal.throwIfAborted();
    const path = join(authDir, name);
    let text: string, mtimeMs: number;
    try { mtimeMs = (await stat(path)).mtimeMs; text = await readFile(path, 'utf8'); }
    catch { throw new Error('Unable to read WorkBuddy desktop credentials'); }
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    const accessToken = doc?.auth?.accessToken;
    let token: string;
    if (typeof accessToken === 'string' && accessToken.trim()) token = accessToken;
    else if (accessToken?.$wbEncrypted === 1 && typeof accessToken.envelope === 'string') {
      const cacheKey = JSON.stringify([path, binary]);
      let cached = desktopTokenCache.get(cacheKey);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        const token = decryptDesktopToken(binary, path, signal);
        cached = { mtimeMs, token }; desktopTokenCache.set(cacheKey, cached);
        void token.catch(() => { if (desktopTokenCache.get(cacheKey) === cached) desktopTokenCache.delete(cacheKey); });
      }
      token = await cached.token;
    } else continue;
    const result = { ...env, CODEBUDDY_AUTH_TOKEN: token };
    const uid = doc?.account?.uid;
    if (!process.env.ACC_USER_ID && (typeof uid === 'string' || typeof uid === 'number') && String(uid)) {
      return { ...result, ACC_USER_ID: String(uid) };
    }
    return result;
  }
  return env;
}
export function createWorkBuddyRunner(options: WorkBuddyOptions): TurnRunner {
  return async context => {
    const binary = await resolveCodeBuddyBinary(options.codebuddyBin);
    context.signal.throwIfAborted();
    const env = await workBuddyEnvironment(binary, context.signal);
    context.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const server = createSdkMcpServer({ name: 'nia', version: '0.1.0', tools: [
      tool('nia_group_chat_send_message', 'Send an interim update to this GroupChat', { content: z.string().trim().min(1) }, async ({ content }) => { await context.send(content); return { content: [{ type: 'text', text: 'Sent' }] }; }),
      tool('nia_group_chat_history', 'Read older messages in this GroupChat', { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, async ({ limit, offset }) => ({ content: [{ type: 'text', text: JSON.stringify(await context.history(limit, offset)) }] })),
    ] });
    try {
      return await consumeSdkQuery(query({ prompt: context.prompt, options: {
        pathToCodebuddyCode: binary, env, cwd: options.cwd, model: options.model, resume: context.resume,
        abortController: controller, permissionMode: options.fullAuto ? 'bypassPermissions' : 'default', allowDangerouslySkipPermissions: Boolean(options.fullAuto),
        settingSources: ['user', 'project', 'local'], systemPrompt: { append: GROUP_CHAT_INSTRUCTIONS },
        mcpServers: { nia: server },
        canUseTool: async (name, input, detail) => {
          // These two scoped collaboration tools need no separate TaskBar approval.
          if (name === 'mcp__nia__nia_group_chat_send_message' || name === 'mcp__nia__nia_group_chat_history') return { behavior: 'allow', updatedInput: input };
          const result = await context.permission(name, input, detail.signal);
          return result.behavior === 'allow' ? { behavior: 'allow', updatedInput: result.updatedInput ?? input } : { behavior: 'deny', message: result.message ?? 'Denied' };
        },
        stderr: data => process.stderr.write(data),
      } }), context);
    } finally { context.signal.removeEventListener('abort', abort); await server.instance.close(); }
  };
}
