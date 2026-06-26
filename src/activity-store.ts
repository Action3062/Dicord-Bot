import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type WarningSource = "manual" | "auto";

export type WarningEntry = {
  id: string;
  reason: string;
  moderatorId: string;
  source: WarningSource;
  active: boolean;
  createdAt: string;
  channelId?: string;
  messageId?: string;
  evidence?: string;
  removedAt?: string;
  removedBy?: string;
  removeReason?: string;
};

type UserStats = {
  messages: number;
  joins: number;
  leaves: number;
  warnings: number;
  warningHistory?: WarningEntry[];
  lastSeenAt?: string;
};

type ChannelStats = {
  messages: number;
};

type ActivityState = {
  users: Record<string, UserStats>;
  channels: Record<string, ChannelStats>;
  updatedAt?: string;
};

const emptyState = (): ActivityState => ({ users: {}, channels: {} });

export class ActivityStore {
  private state: ActivityState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new ActivityStore(join(dataDir, "activity.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<ActivityState>(this.filePath);
    if (loaded) {
      this.state = loaded;
      this.normalizeState();
    } else {
      this.state = emptyState();
    }
    this.loaded = true;
  }

  async recordMessage(userId: string, channelId: string) {
    await this.load();
    const user = this.user(userId);
    const channel = this.channel(channelId);
    user.messages += 1;
    user.lastSeenAt = new Date().toISOString();
    channel.messages += 1;
    await this.save();
  }

  async recordJoin(userId: string) {
    await this.load();
    this.user(userId).joins += 1;
    await this.save();
  }

  async recordLeave(userId: string) {
    await this.load();
    this.user(userId).leaves += 1;
    await this.save();
  }

  async addWarning(userId: string, warning?: {
    reason?: string;
    moderatorId?: string;
    source?: WarningSource;
    channelId?: string;
    messageId?: string;
    evidence?: string;
  }) {
    await this.load();
    const user = this.user(userId);
    user.warningHistory ??= [];
    const entry: WarningEntry = {
      id: randomUUID().slice(0, 8),
      reason: warning?.reason?.trim() || "Keine Angabe",
      moderatorId: warning?.moderatorId || "bot",
      source: warning?.source ?? "manual",
      active: true,
      createdAt: new Date().toISOString(),
      channelId: warning?.channelId,
      messageId: warning?.messageId,
      evidence: warning?.evidence
    };
    user.warningHistory.push(entry);
    user.warnings = activeWarnings(user).length;
    await this.save();
    return { entry, total: user.warnings };
  }

  async removeWarning(userId: string, warningId: string | undefined, removedBy: string, reason?: string) {
    await this.load();
    const user = this.user(userId);
    this.ensureWarningHistory(user);
    const active = activeWarnings(user);
    const entry = warningId
      ? active.find((item) => item.id.toLowerCase() === warningId.toLowerCase())
      : active[active.length - 1];

    if (!entry) return null;
    entry.active = false;
    entry.removedAt = new Date().toISOString();
    entry.removedBy = removedBy;
    entry.removeReason = reason?.trim() || "Keine Angabe";
    user.warnings = activeWarnings(user).length;
    await this.save();
    return { entry, total: user.warnings };
  }

  async listWarnings(userId: string, includeInactive = false) {
    await this.load();
    const user = this.user(userId);
    this.ensureWarningHistory(user);
    const warnings = user.warningHistory ?? [];
    return (includeInactive ? warnings : warnings.filter((warning) => warning.active))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getUser(userId: string) {
    await this.load();
    const user = this.user(userId);
    this.ensureWarningHistory(user);
    user.warnings = activeWarnings(user).length;
    return this.user(userId);
  }

  async topUsers(limit = 5) {
    await this.load();
    return Object.entries(this.state.users)
      .sort((a, b) => b[1].messages - a[1].messages)
      .slice(0, limit);
  }

  private user(userId: string) {
    this.state.users[userId] ||= { messages: 0, joins: 0, leaves: 0, warnings: 0, warningHistory: [] };
    const user = this.state.users[userId];
    this.ensureWarningHistory(user);
    return user;
  }

  private channel(channelId: string) {
    this.state.channels[channelId] ||= { messages: 0 };
    return this.state.channels[channelId];
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }

  private normalizeState() {
    this.state.users ??= {};
    this.state.channels ??= {};
    for (const user of Object.values(this.state.users)) {
      this.ensureWarningHistory(user);
    }
  }

  private ensureWarningHistory(user: UserStats) {
    user.messages ??= 0;
    user.joins ??= 0;
    user.leaves ??= 0;
    user.warnings ??= 0;
    if (!user.warningHistory) {
      user.warningHistory = Array.from({ length: user.warnings }, (_, index) => ({
        id: `legacy-${index + 1}`,
        reason: "Alte Warnung ohne Verlauf",
        moderatorId: "bot",
        source: "manual" as const,
        active: true,
        createdAt: new Date(0).toISOString()
      }));
    }
    user.warnings = activeWarnings(user).length;
  }
}

function activeWarnings(user: UserStats) {
  return (user.warningHistory ?? []).filter((warning) => warning.active);
}
