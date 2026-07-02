import { fetchFlags } from "./portal.js";

// Runtime feature-flag overrides pulled from the payment portal. The portal can
// send true/false to force a feature on/off, or null to keep the bot's own env
// default. env still decides whether a listener is registered at startup; these
// overrides gate the behavior at execution time, so the admin can flip a
// feature from the panel without restarting the bot.

let overrides: Record<string, boolean> = {};

/** Whether a feature is active, honoring a portal override, else the env fallback. */
export function flag(name: string, fallback: boolean): boolean {
  return name in overrides ? overrides[name] : fallback;
}

export async function refreshFlags(): Promise<void> {
  const flags = await fetchFlags();
  if (!flags) return; // portal unreachable/unconfigured -> keep last known overrides
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value === "boolean") next[key] = value;
  }
  overrides = next;
}
