import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { normalizeServerUrl } from './http.js';
import type { Credentials } from './types.js';

const SYSTEM_ROOT_ALIASES = new Set(['var', 'tmp', 'etc', 'home', 'Users', 'workspace']);

export function defaultConfigDir(dirName = 'nia-teams-agent-bridge', envVar?: string): string {
  return (envVar ? process.env[envVar] : undefined) || join(homedir(), '.config', dirName);
}
async function inspect(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Reject roots; exempt only existing allowlisted system aliases, with root-owned
 * link and directory target on POSIX. Every component below that base is checked. */
export async function configDirectory(configDir: string, create: boolean): Promise<string> {
  const absolute = resolve(configDir);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  if (parts.length === 0) throw new Error('Filesystem root cannot be a config directory');
  let base = root;
  if (parts.length > 1 && SYSTEM_ROOT_ALIASES.has(parts[0]!)) {
    const alias = join(root, parts[0]!);
    const info = await inspect(alias);
    if (info?.isDirectory()) base = alias;
    else if (info?.isSymbolicLink() && typeof process.getuid === 'function' && info.uid === 0) {
      const target = await realpath(alias);
      const targetInfo = await lstat(target);
      if (targetInfo.isDirectory() && targetInfo.uid === 0) base = alias;
    }
  }
  // All other paths start at the filesystem root and reject every symlink.
  // HOME/TMPDIR never define a trusted boundary.
  const segments = relative(base, absolute).split(sep).filter(Boolean);
  let current = await realpath(base);
  if (!(await lstat(current)).isDirectory()) throw new Error('Config base must be a directory');
  for (const segment of segments) {
    current = join(current, segment);
    let info = await inspect(current);
    if (!info && create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      info = await inspect(current);
    }
    if (!info) throw new Error('Config directory does not exist');
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Config directory path must be a regular directory, not a symbolic link');
  }
  return current;
}

async function checkCredentialTarget(path: string): Promise<void> {
  const info = await inspect(path);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Credentials must be a regular private file, not a symbolic link');
}

export async function saveCredentials(credentials: Credentials, configDir = defaultConfigDir()): Promise<void> {
  const directory = await configDirectory(configDir, true);
  const target = join(directory, 'credentials.json');
  await checkCredentialTarget(target);
  await chmod(directory, 0o700);
  const temp = join(directory, `.credentials-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (await configDirectory(configDir, false) !== directory) throw new Error('Config directory changed during credentials write');
    await checkCredentialTarget(target);
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}
export async function loadCredentials(configDir = defaultConfigDir()): Promise<Credentials> {
  const path = join(await configDirectory(configDir, false), 'credentials.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Credentials must be a regular private file (chmod 600), not a symbolic link');
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as Credentials;
  for (const key of ['serverUrl', 'teamId', 'agentSlug', 'agentName', 'issuer', 'hostLabel', 'publicKeyPem', 'privateKeyPem', 'pairedAt'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`Invalid credentials: ${key}`);
  }
  if (!/^[a-f\d]{24}$/i.test(value.teamId) || !Number.isSafeInteger(value.keyGeneration) || value.keyGeneration < 1) throw new Error('Invalid paired Agent identity');
  normalizeServerUrl(value.serverUrl);
  const key = createPrivateKey(value.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim() !== value.publicKeyPem.trim()) throw new Error('Invalid Ed25519 keypair');
  return value;
}
