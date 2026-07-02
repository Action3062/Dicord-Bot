import { config } from "./config.js";

// Client for the payment portal's bot-facing API. Reads (flags, support) are
// public; writes (heartbeat, report, command ack) carry BOT_API_SECRET as a
// Bearer token. Everything is best-effort and time-bounded: the portal being
// down must never disturb the bot.

const TIMEOUT_MS = 6000;

export function portalConfigured() {
  return Boolean(config.PORTAL_BASE_URL);
}
function portalWritable() {
  return Boolean(config.PORTAL_BASE_URL && config.BOT_API_SECRET);
}
function base() {
  return config.PORTAL_BASE_URL.replace(/\/+$/, "");
}

async function get<T>(path: string): Promise<T | null> {
  if (!portalConfigured()) return null;
  try {
    const res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`[portal] GET ${path} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function post(path: string, body: unknown): Promise<boolean> {
  if (!portalWritable()) return false;
  try {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.BOT_API_SECRET}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (error) {
    console.warn(`[portal] POST ${path} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export type BotFlags = Record<string, boolean | null>;
export async function fetchFlags(): Promise<BotFlags | null> {
  const data = await get<{ flags?: BotFlags }>("/pay/api/bot/flags");
  return data?.flags ?? null;
}

export type SupportPayload = { status: "online" | "busy" | "offline"; message: string };
export async function fetchSupport(): Promise<SupportPayload | null> {
  return get<SupportPayload>("/pay/api/support/status");
}

export async function sendHeartbeat(): Promise<void> {
  await post("/pay/api/bot/heartbeat", { at: new Date().toISOString() });
}

export async function sendReport(kind: "trials" | "tickets", payload: unknown): Promise<void> {
  await post("/pay/api/bot/report", { kind, payload });
}

export async function sendFunnelSnapshots(snapshots: Array<{
  guildId: string; trials: number; upgrades: number; expired: number;
  reactivated: number; activeAbos: number; activeTrials: number; periodEnd: string;
}>): Promise<void> {
  if (!snapshots.length) return;
  await post("/pay/api/bot/report", { kind: "funnel", snapshots });
}

export type PortalCommand = { id: string; kind: string; target: string };
export async function fetchCommands(): Promise<PortalCommand[]> {
  if (!portalWritable()) return [];
  try {
    const res = await fetch(`${base()}/pay/api/bot/commands`, {
      headers: { Authorization: `Bearer ${config.BOT_API_SECRET}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PortalCommand[];
  } catch (error) {
    console.warn(`[portal] Befehle laden fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export async function ackCommand(id: string, status: "done" | "failed", result?: string): Promise<void> {
  await post("/pay/api/bot/commands/ack", { id, status, result });
}
