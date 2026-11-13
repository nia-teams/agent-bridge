import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { configDirectory } from './credentials.js';
export { configDirectory as resolvePrivateConfigDir } from './credentials.js';

/** Single-process private atomic JSON state. Validation belongs to the state owner. */
export class JsonFileStore<T> {
  private writes = Promise.resolve();
  constructor(private readonly configDir: string, private readonly filename: string, private readonly validate: (value: unknown) => T) {
    if (basename(filename) !== filename || filename === '.' || filename === '..') throw new Error('State filename must be a basename');
  }
  async load(fallback: T): Promise<T> {
    const dir = await configDirectory(this.configDir, true);
    const path = join(dir, this.filename);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error(`${this.filename} must be a private regular file (chmod 600)`);
      return this.validate(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
  }
  save(value: T): Promise<void> {
    const snapshot = JSON.stringify(this.validate(value), null, 2) + '\n';
    const task = this.writes.then(async () => {
      const dir = await configDirectory(this.configDir, true);
      await chmod(dir, 0o700);
      const path = join(dir, this.filename);
      const check = async () => {
        try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid ${this.filename} target`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
      await check(); const temp = join(dir, `.state-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, snapshot, { mode: 0o600, flag: 'wx' });
        if (await configDirectory(this.configDir, false) !== dir) throw new Error('Config directory changed');
        await check(); await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    });
    this.writes = task.catch(() => {}); return task;
  }
}
export interface SessionMapping { sessionId: string; groupChatId: string; updatedAt: string }
export class ThreadMapStore {
  private readonly file: JsonFileStore<Record<string, SessionMapping>>;
  private values: Record<string, SessionMapping> = Object.create(null);
  constructor(configDir: string) {
    this.file = new JsonFileStore(configDir, 'threads.json', value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid thread mappings');
      for (const entry of Object.values(value)) {
        if (!entry || typeof entry !== 'object' || typeof entry.sessionId !== 'string' || !entry.sessionId || typeof entry.groupChatId !== 'string' || typeof entry.updatedAt !== 'string') throw new Error('Invalid thread mapping');
      }
      return Object.assign(Object.create(null), value);
    });
  }
  async load(): Promise<void> { this.values = await this.file.load(Object.create(null)); }
  get(id: string): SessionMapping | undefined { return this.values[id]; }
  set(id: string, entry: SessionMapping): Promise<void> { this.values[id] = entry; return this.file.save(this.values); }
}
