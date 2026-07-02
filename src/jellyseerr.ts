import { config } from "./config.js";

const REQUEST_TIMEOUT_MS = 15_000;

export function isJellyseerrConfigured() {
  return Boolean(config.JELLYSEERR_BASE_URL && config.JELLYSEERR_API_KEY);
}

function base() {
  return config.JELLYSEERR_BASE_URL.replace(/\/+$/, "");
}

async function jellyseerr(path: string, init?: RequestInit) {
  const res = await fetch(`${base()}/api/v1${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), "X-Api-Key": config.JELLYSEERR_API_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jellyseerr ${path} fehlgeschlagen: ${res.status} ${text.slice(0, 200)}`.trim());
  }
  return res.json();
}

// Jellyseerr media status: 2 pending, 3 processing, 4 partially available, 5 available.
export const JELLYSEERR_STATUS_AVAILABLE = 5;

export type JellyseerrSearchResult = {
  id: number; // TMDB id
  mediaType: "movie" | "tv";
  title: string;
  year?: string;
  status?: number;
};

export async function searchJellyseerr(query: string): Promise<JellyseerrSearchResult[]> {
  const data = (await jellyseerr(`/search?query=${encodeURIComponent(query)}&page=1&language=de`)) as {
    results?: Array<Record<string, unknown>>;
  };
  const out: JellyseerrSearchResult[] = [];
  for (const raw of data.results ?? []) {
    const mediaType = raw.mediaType;
    if (mediaType !== "movie" && mediaType !== "tv") continue; // skip person results
    const id = Number(raw.id);
    if (!Number.isFinite(id)) continue;
    const title = String(raw.title ?? raw.name ?? "Unbenannt");
    const date = String(raw.releaseDate ?? raw.firstAirDate ?? "");
    const mediaInfo = raw.mediaInfo as Record<string, unknown> | undefined;
    out.push({
      id,
      mediaType,
      title,
      year: date ? date.slice(0, 4) : undefined,
      status: mediaInfo ? Number(mediaInfo.status) : undefined
    });
    if (out.length >= 3) break;
  }
  return out;
}

export async function createJellyseerrRequest(mediaType: "movie" | "tv", tmdbId: number): Promise<void> {
  const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
  if (mediaType === "tv") body.seasons = "all";
  await jellyseerr("/request", { method: "POST", body: JSON.stringify(body) });
}
