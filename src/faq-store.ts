import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FaqItem } from "./faq.js";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type StoredFaqItem = FaqItem & {
  createdAt: string;
  approvedBy: string;
  sourceTicketId?: string;
};

type FaqState = {
  items: StoredFaqItem[];
  updatedAt?: string;
};

const emptyState = (): FaqState => ({ items: [] });

export class FaqStore {
  private state: FaqState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new FaqStore(join(dataDir, "faq.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<FaqState>(this.filePath);
    if (loaded) {
      this.state = loaded;
      this.state.items ??= [];
    } else {
      this.state = emptyState();
    }
    this.loaded = true;
  }

  async add(item: FaqItem & { approvedBy: string; sourceTicketId?: string }) {
    await this.load();
    const existingIndex = this.state.items.findIndex((entry) =>
      entry.title.toLowerCase() === item.title.toLowerCase()
    );
    const stored: StoredFaqItem = {
      title: item.title,
      keywords: item.keywords,
      answer: item.answer,
      approvedBy: item.approvedBy,
      sourceTicketId: item.sourceTicketId,
      createdAt: new Date().toISOString()
    };
    if (existingIndex >= 0) this.state.items[existingIndex] = stored;
    else this.state.items.push(stored);
    await this.save();
    return stored;
  }

  async list() {
    await this.load();
    return this.state.items.slice();
  }

  async search(input: string, limit = 8) {
    const items = await this.list();
    const normalized = input.toLowerCase().trim();
    return items
      .map((item) => {
        if (!normalized) return { item, score: 1 };
        const titleScore = item.title.toLowerCase().includes(normalized) ? 3 : 0;
        const keywordScore = item.keywords.filter((keyword) => keyword.includes(normalized) || normalized.includes(keyword)).length;
        return { item, score: titleScore + keywordScore };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  async answer(input: string) {
    const normalized = input.toLowerCase();
    const items = await this.list();
    const exact = items.find((item) => item.title.toLowerCase() === normalized);
    if (exact) return exact;

    const scored = items.map((item) => ({
      item,
      score: item.keywords.filter((keyword) => normalized.includes(keyword)).length
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    return best && best.score > 0 ? best.item : undefined;
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
