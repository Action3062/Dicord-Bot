import { config } from "./config.js";

// Remote on/off switch (and parameters) for trial handouts, controlled from the
// payment portal's admin panel:
//   GET /pay/api/trial/status -> { enabled, trial_hours, nudge_hours }
// The endpoint is TRIAL_STATUS_URL, or derived from PORTAL_BASE_URL when that is
// set. With neither configured the bot keeps the old behavior (trials always
// allowed, env parameters). When an endpoint is set but unreachable we fail
// closed so trials cannot be farmed while the portal is down.

export type TrialGateResult = {
  allowed: boolean;
  reason: "unconfigured" | "enabled" | "disabled" | "unreachable";
  trialHours?: number; // portal override for the trial duration, if provided
  nudgeHours?: number; // portal override for the conversion nudge timing
};

function statusUrl(): string {
  if (config.TRIAL_STATUS_URL) return config.TRIAL_STATUS_URL;
  if (config.PORTAL_BASE_URL) return `${config.PORTAL_BASE_URL.replace(/\/+$/, "")}/pay/api/trial/status`;
  return "";
}

export async function checkTrialGate(): Promise<TrialGateResult> {
  const url = statusUrl();
  if (!url) return { allowed: true, reason: "unconfigured" };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    const data = (await res.json()) as { enabled?: unknown; trial_hours?: unknown; nudge_hours?: unknown };
    const trialHours = Number(data.trial_hours);
    const nudgeHours = Number(data.nudge_hours);
    const params = {
      trialHours: Number.isFinite(trialHours) && trialHours > 0 ? trialHours : undefined,
      nudgeHours: Number.isFinite(nudgeHours) && nudgeHours > 0 ? nudgeHours : undefined
    };
    return data.enabled === true
      ? { allowed: true, reason: "enabled", ...params }
      : { allowed: false, reason: "disabled", ...params };
  } catch (error) {
    console.warn(`[trial-gate] Statusabfrage fehlgeschlagen (${url}): ${error instanceof Error ? error.message : String(error)}`);
    return { allowed: false, reason: "unreachable" };
  }
}
