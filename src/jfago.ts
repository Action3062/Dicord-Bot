import { config } from "./config.js";

// All jfa-go calls are bounded so a hung jfa-go can never block a command handler.
const REQUEST_TIMEOUT_MS = 15_000;

function base() {
  return config.JFA_GO_BASE_URL.replace(/\/+$/, "");
}

export function isJfaGoConfigured() {
  return Boolean(config.JFA_GO_BASE_URL && config.JFA_GO_ADMIN_USER && config.JFA_GO_ADMIN_PASSWORD);
}

// jfa-go admin tokens are short-lived; cache briefly and re-login on demand.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function login(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const auth = Buffer.from(`${config.JFA_GO_ADMIN_USER}:${config.JFA_GO_ADMIN_PASSWORD}`).toString("base64");
  const res = await fetch(`${base()}/token/login`, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`jfa-go Login fehlgeschlagen: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("jfa-go Login: kein Token erhalten");
  cachedToken = { token: data.token, expiresAt: Date.now() + 15 * 60_000 };
  return data.token;
}

async function authed(path: string, init: RequestInit) {
  const token = await login();
  return fetch(`${base()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

type InviteListResponse = { invites?: Array<{ code?: string; label?: string }> };

/**
 * Create a single-use jfa-go invite whose created account expires after `trialHours`,
 * then immediately redeem it to create the account with a known password.
 * Returns nothing on success; throws with a descriptive message on any failure.
 */
export async function createTrialAccount(options: {
  username: string;
  password: string;
  trialHours: number;
  label: string;
}): Promise<void> {
  const userDays = Math.floor(options.trialHours / 24);
  const userHours = options.trialHours % 24;

  const inviteBody = {
    months: 0,
    days: 0,
    hours: 2,
    minutes: 0,
    "user-expiry": true,
    "user-months": 0,
    "user-days": userDays,
    "user-hours": userHours,
    "user-minutes": 0,
    "multiple-uses": false,
    "no-limit": false,
    "remaining-uses": 1,
    "send-to": "",
    profile: config.JFA_GO_PROFILE,
    label: options.label,
    user_label: "Trial"
  };

  const inviteRes = await authed("/invites", { method: "POST", body: JSON.stringify(inviteBody) });
  if (!inviteRes.ok) throw new Error(`jfa-go Einladung erstellen fehlgeschlagen: ${inviteRes.status} ${inviteRes.statusText}`);

  // The create response only returns a boolean, so look the code up by our unique label.
  const listRes = await authed("/invites", { method: "GET" });
  if (!listRes.ok) throw new Error(`jfa-go Einladungen laden fehlgeschlagen: ${listRes.status} ${listRes.statusText}`);
  const list = (await listRes.json()) as InviteListResponse;
  const code = list.invites?.find((invite) => invite.label === options.label)?.code;
  if (!code) throw new Error("jfa-go: erzeugter Einladungscode wurde nicht gefunden");

  // Public invite-redeem endpoint. Captcha/email are disabled on this instance, so
  // those fields are sent empty.
  const newUserBody = {
    code,
    username: options.username,
    password: options.password,
    email: "",
    email_contact: false,
    captcha_id: "",
    captcha_text: ""
  };
  const createRes = await fetch(`${base()}/user/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newUserBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw new Error(`jfa-go Account anlegen fehlgeschlagen: ${createRes.status} ${text}`.trim());
  }
}
