import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonState, writeJsonStateAtomic } from "./persistence.js";

export type TicketStatus = "open" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export type Ticket = {
  id: string;
  number: number;
  guildId: string;
  channelId: string;
  ownerId: string;
  category: string;
  priority?: TicketPriority;
  priorityReason?: string;
  aiSummary?: string;
  missingInfoQuestions?: string[];
  subject: string;
  description?: string;
  status: TicketStatus;
  participants: string[];
  createdAt: string;
  closedAt?: string;
  closedBy?: string;
  closeReason?: string;
  transcriptPath?: string;
  lastUserMessageAt?: string;
  lastTeamMessageAt?: string;
  lastFollowUpAt?: string;
  followUpCount?: number;
};

type TicketState = {
  nextNumbers: Record<string, number>;
  tickets: Record<string, Ticket>;
  updatedAt?: string;
};

const emptyState = (): TicketState => ({ nextNumbers: {}, tickets: {} });

export class TicketStore {
  private state: TicketState = emptyState();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  static fromDataDir(dataDir: string) {
    return new TicketStore(join(dataDir, "tickets.json"));
  }

  async load() {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const loaded = await readJsonState<TicketState>(this.filePath);
    if (loaded) {
      this.state = loaded;
      this.state.nextNumbers ??= {};
      this.state.tickets ??= {};
    } else {
      this.state = emptyState();
    }
    this.loaded = true;
  }

  async nextNumber(guildId: string) {
    await this.load();
    const next = this.state.nextNumbers[guildId] ?? 1;
    this.state.nextNumbers[guildId] = next + 1;
    await this.save();
    return next;
  }

  async create(ticket: Omit<Ticket, "id" | "status" | "createdAt" | "participants"> & { participants?: string[] }) {
    await this.load();
    const id = `${ticket.guildId}:${ticket.number}`;
    const created: Ticket = {
      ...ticket,
      id,
      status: "open",
      participants: ticket.participants ?? [],
      createdAt: new Date().toISOString()
    };
    created.lastUserMessageAt = created.createdAt;
    this.state.tickets[id] = created;
    await this.save();
    return created;
  }

  async getByChannel(guildId: string, channelId: string) {
    await this.load();
    return Object.values(this.state.tickets).find((ticket) =>
      ticket.guildId === guildId && ticket.channelId === channelId
    );
  }

  async getOpenByOwner(guildId: string, ownerId: string) {
    await this.load();
    return Object.values(this.state.tickets).filter((ticket) =>
      ticket.guildId === guildId && ticket.ownerId === ownerId && ticket.status === "open"
    );
  }

  async listOpen(guildId: string) {
    await this.load();
    return Object.values(this.state.tickets)
      .filter((ticket) => ticket.guildId === guildId && ticket.status === "open")
      .sort((a, b) => a.number - b.number);
  }

  async addParticipant(ticketId: string, userId: string) {
    await this.load();
    const ticket = this.state.tickets[ticketId];
    if (!ticket) return undefined;
    if (!ticket.participants.includes(userId)) ticket.participants.push(userId);
    await this.save();
    return ticket;
  }

  async removeParticipant(ticketId: string, userId: string) {
    await this.load();
    const ticket = this.state.tickets[ticketId];
    if (!ticket) return undefined;
    ticket.participants = ticket.participants.filter((participant) => participant !== userId);
    await this.save();
    return ticket;
  }

  async recordMessage(ticketId: string, authorType: "team" | "user") {
    await this.load();
    const ticket = this.state.tickets[ticketId];
    if (!ticket || ticket.status !== "open") return undefined;
    const now = new Date().toISOString();
    if (authorType === "team") ticket.lastTeamMessageAt = now;
    else ticket.lastUserMessageAt = now;
    await this.save();
    return ticket;
  }

  async markFollowUp(ticketId: string) {
    await this.load();
    const ticket = this.state.tickets[ticketId];
    if (!ticket || ticket.status !== "open") return undefined;
    ticket.lastFollowUpAt = new Date().toISOString();
    ticket.followUpCount = (ticket.followUpCount ?? 0) + 1;
    await this.save();
    return ticket;
  }

  async close(ticketId: string, closedBy: string, closeReason?: string, transcriptPath?: string) {
    await this.load();
    const ticket = this.state.tickets[ticketId];
    if (!ticket) return undefined;
    ticket.status = "closed";
    ticket.closedAt = new Date().toISOString();
    ticket.closedBy = closedBy;
    ticket.closeReason = closeReason;
    ticket.transcriptPath = transcriptPath;
    await this.save();
    return ticket;
  }

  private async save() {
    this.state.updatedAt = new Date().toISOString();
    await writeJsonStateAtomic(this.filePath, this.state);
  }
}
