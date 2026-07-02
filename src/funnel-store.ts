import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type FunnelCounters = { trials: number; upgrades: number; expired: number; reactivated: number };

type FunnelState = {
  counters: Record<string, FunnelCounters>; // guildId -> counters since the last report
  lastReportAt?: string; // ISO timestamp of the last weekly report
  updatedAt?: string;
};

const emptyCounters = (): FunnelCounters => ({ trials: 0, upgrades: 0, expired: 0, reactivated: 0 });
const emptyState = (): FunnelState => ({ counters: {} });

/** Weekly abo-funnel counters for the team report (data/funnel.json). */
export class FunnelStore {
  private state: FunnelState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new FunnelStore(join(dataDir, "funnel.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<FunnelState>(this.filePath);
    this.state = loaded ?? emptyState();
    this.state.counters ??= {};
    this.loaded = true;
  }

  async increment(guildId: string, key: keyof FunnelCounters) {
    await this.load();
    const counters = (this.state.counters[guildId] ??= emptyCounters());
    counters[key] += 1;
    await this.save();
  }

  async getCounters(guildId: string): Promise<FunnelCounters> {
    await this.load();
    return this.state.counters[guildId] ?? emptyCounters();
  }

  async getLastReportAt(): Promise<string | undefined> {
    await this.load();
    return this.state.lastReportAt;
  }

  async resetAfterReport(guildId: string, at: string) {
    await this.load();
    this.state.counters[guildId] = emptyCounters();
    this.state.lastReportAt = at;
    await this.save();
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
