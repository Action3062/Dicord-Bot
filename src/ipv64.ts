import { config } from "./config.js";

const REQUEST_TIMEOUT_MS = 15_000;

export function isIpv64Configured() {
  return Boolean(config.IPV64_API_KEY);
}

export type Healthcheck = {
  name: string;
  status: "up" | "down" | "unknown";
};

// Reads the account's healthchecks from ipv64. Only the name and a normalized
// status are returned - secret fields (healthtoken, target IPs in type_options)
// are dropped here and never surfaced to Discord.
export async function getHealthchecks(): Promise<Healthcheck[]> {
  const res = await fetch("https://ipv64.net/api.php?get_healthchecks", {
    headers: { Authorization: `Bearer ${config.IPV64_API_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`ipv64 Healthchecks fehlgeschlagen: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as Record<string, unknown>;
  const checks: Healthcheck[] = [];
  for (const value of Object.values(data)) {
    // Meta fields (info/status/get_account_info) are strings and skipped here.
    if (!value || typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj.name !== "string") continue;
    const raw = Number(obj.healthstatus);
    const status: Healthcheck["status"] = raw === 1 ? "up" : raw === 3 ? "down" : "unknown";
    checks.push({ name: obj.name, status });
  }
  return checks;
}
