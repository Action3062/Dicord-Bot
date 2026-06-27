import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type TrialEntry = {
  userId: string;
  jellyfinUsername: string;
  createdAt: string; // ISO timestamp
  expiresAt: number; // epoch milliseconds
  roleId?: string;
  roleRemoved?: boolean;
};

type TrialState = {
  guilds: Record<string, Record<string, TrialEntry>>; // guildId -> userId -> entry
  updatedAt?: string;
};

const emptyState = (): TrialState => ({ guilds: {} });

export class TrialStore {
  private state: TrialState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new TrialStore(join(dataDir, "trials.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<TrialState>(this.filePath);
    this.state = loaded ?? emptyState();
    this.state.guilds ??= {};
    this.loaded = true;
  }

  async get(guildId: string, userId: string): Promise<TrialEntry | undefined> {
    await this.load();
    return this.state.guilds[guildId]?.[userId];
  }

  async set(guildId: string, entry: TrialEntry) {
    await this.load();
    (this.state.guilds[guildId] ??= {})[entry.userId] = entry;
    await this.save();
  }

  async activeEntries(): Promise<Array<{ guildId: string; entry: TrialEntry }>> {
    await this.load();
    const out: Array<{ guildId: string; entry: TrialEntry }> = [];
    for (const [guildId, users] of Object.entries(this.state.guilds)) {
      for (const entry of Object.values(users)) {
        if (!entry.roleRemoved) out.push({ guildId, entry });
      }
    }
    return out;
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
