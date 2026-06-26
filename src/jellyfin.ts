import { config } from "./config.js";

// Abort external requests so a hung portal/Jellyfin endpoint can never block a
// command handler indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

type PortalHealth = {
  ok?: boolean;
  shop?: string;
};

type JellyfinInfo = {
  ServerName?: string;
  Version?: string;
  OperatingSystem?: string;
};

export type JellyfinMediaItem = {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  DateCreated?: string;
  Path?: string;
};

type JellyfinItemsResponse = {
  Items?: JellyfinMediaItem[];
  TotalRecordCount?: number;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export async function getPortalHealth() {
  return fetchJson<PortalHealth>(`${trimTrailingSlash(config.API_PUBLIC_BASE_URL)}/health`);
}

export async function checkPortalUser(username: string) {
  const response = await fetch(`${trimTrailingSlash(config.API_PUBLIC_BASE_URL)}/pay/api/user/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`User-Check fehlgeschlagen: ${response.status}`);
  return response.json() as Promise<{ exists: boolean }>;
}

export async function getJellyfinInfo() {
  if (!config.JELLYFIN_BASE_URL) return { configured: false as const };

  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const path = config.JELLYFIN_API_KEY ? "/System/Info" : "/System/Info/Public";
  const headers = config.JELLYFIN_API_KEY ? { "X-Emby-Token": config.JELLYFIN_API_KEY } : undefined;
  const info = await fetchJson<JellyfinInfo>(`${base}${path}`, { headers });
  return { configured: true as const, info };
}

export async function getActiveSessionCount() {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) return undefined;
  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const sessions = await fetchJson<unknown[]>(`${base}/Sessions`, {
    headers: { "X-Emby-Token": config.JELLYFIN_API_KEY }
  });
  return sessions.length;
}

export async function searchJellyfinMedia(query: string) {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) {
    return { configured: false as const, query, items: [], total: 0 };
  }

  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const params = new URLSearchParams({
    Recursive: "true",
    SearchTerm: query,
    IncludeItemTypes: "Movie,Series",
    Fields: "DateCreated,Path,PremiereDate,ProductionYear",
    Limit: "5"
  });
  const result = await fetchJson<JellyfinItemsResponse>(`${base}/Items?${params}`, {
    headers: { "X-Emby-Token": config.JELLYFIN_API_KEY }
  });

  return {
    configured: true as const,
    query,
    items: result.Items ?? [],
    total: result.TotalRecordCount ?? result.Items?.length ?? 0
  };
}

export async function refreshJellyfinLibrary() {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) {
    throw new Error("Jellyfin API ist nicht konfiguriert.");
  }

  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const response = await fetch(`${base}/Library/Refresh`, {
    method: "POST",
    headers: { "X-Emby-Token": config.JELLYFIN_API_KEY },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Bibliotheksscan fehlgeschlagen: ${response.status} ${response.statusText}`);
}
