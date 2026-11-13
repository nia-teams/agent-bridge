import { JsonFileStore } from '@nia-teams/agent-bridge-core';
export interface ThreadMapping { codexThreadId: string; groupChatId: string; updatedAt: string }
export class ThreadStore {
  private readonly file: JsonFileStore<Record<string, ThreadMapping>>;
  private values: Record<string, ThreadMapping> = Object.create(null);
  constructor(configDir: string) {
    this.file = new JsonFileStore(configDir, 'threads.json', value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid thread mappings');
      for (const entry of Object.values(value)) {
        if (!entry || typeof entry.codexThreadId !== 'string' || !entry.codexThreadId || typeof entry.groupChatId !== 'string' || typeof entry.updatedAt !== 'string') throw new Error('Invalid thread mapping');
      }
      return Object.assign(Object.create(null), value);
    });
  }
  async load(): Promise<void> { this.values = await this.file.load(Object.create(null)); }
  get(id: string): ThreadMapping | undefined { return this.values[id]; }
  set(id: string, entry: ThreadMapping): Promise<void> { this.values[id] = entry; return this.file.save(this.values); }
}
