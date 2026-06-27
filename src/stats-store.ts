import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type StatsChannelKind =
  | "total-movies"
  | "total-series"
  | "total-episodes"
  | "library";

export type StatsChannelEntry = {
  channelId: string;
  kind: StatsChannelKind;
  libraryId?: string;
};

export type GuildStatsState = {
  categoryId?: string;
  channels: StatsChannelEntry[];
};

type StatsState = {
  guilds: Record<string, GuildStatsState>;
  updatedAt?: string;
};

const emptyState = (): StatsState => ({ guilds: {} });

export class StatsStore {
  private state: StatsState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new StatsStore(join(dataDir, "stats.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<StatsState>(this.filePath);
    this.state = loaded ?? emptyState();
    this.state.guilds ??= {};
    this.loaded = true;
  }

  async getGuild(guildId: string): Promise<GuildStatsState | undefined> {
    await this.load();
    return this.state.guilds[guildId];
  }

  async setGuild(guildId: string, value: GuildStatsState) {
    await this.load();
    this.state.guilds[guildId] = value;
    await this.save();
  }

  async clearGuild(guildId: string) {
    await this.load();
    delete this.state.guilds[guildId];
    await this.save();
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
