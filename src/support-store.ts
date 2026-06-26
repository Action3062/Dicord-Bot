import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type SupportStatus = "online" | "busy" | "offline";

export type SupportState = {
  status: SupportStatus;
  message: string;
  updatedAt?: string;
  updatedBy?: string;
};

const defaultState = (): SupportState => ({
  status: "offline",
  message: "Support ist aktuell nicht aktiv markiert."
});

export class SupportStore {
  private state: SupportState = defaultState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new SupportStore(join(dataDir, "support-status.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<SupportState>(this.filePath);
    this.state = loaded ? { ...defaultState(), ...loaded } : defaultState();
    this.loaded = true;
  }

  async get() {
    await this.load();
    return this.state;
  }

  async set(status: SupportStatus, message: string, updatedBy: string) {
    await this.load();
    this.state = {
      status,
      message,
      updatedAt: new Date().toISOString(),
      updatedBy
    };
    await this.save();
    return this.state;
  }

  private async save() {
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
