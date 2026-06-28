import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

type SetupState = {
  guilds: Record<string, Record<string, string>>; // guildId -> logical key -> Discord id
  updatedAt?: string;
};

const emptyState = (): SetupState => ({ guilds: {} });

/**
 * Remembers the Discord IDs of bot-created roles/channels so they can be found by
 * ID even after an admin renames them - preventing duplicate creation on re-setup.
 */
export class SetupStore {
  private state: SetupState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new SetupStore(join(dataDir, "setup.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<SetupState>(this.filePath);
    this.state = loaded ?? emptyState();
    this.state.guilds ??= {};
    this.loaded = true;
  }

  async getId(guildId: string, key: string): Promise<string | undefined> {
    await this.load();
    return this.state.guilds[guildId]?.[key];
  }

  async setId(guildId: string, key: string, id: string) {
    await this.load();
    if (this.state.guilds[guildId]?.[key] === id) return;
    (this.state.guilds[guildId] ??= {})[key] = id;
    await this.save();
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
