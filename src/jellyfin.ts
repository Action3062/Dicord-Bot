import { config } from "./config.js";

// Abort external requests so a hung portal/Jellyfin endpoint can never block a
// command handler indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

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
  Overview?: string;
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

type JellyfinUser = {
  Name?: string;
  Id?: string;
};

// Checks a username directly against the Jellyfin server (the bot already holds
// an admin API key), replacing the removed shop/portal user-check endpoint.
export async function checkJellyfinUser(username: string): Promise<{ configured: boolean; exists: boolean }> {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) {
    return { configured: false, exists: false };
  }
  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const users = await fetchJson<JellyfinUser[]>(`${base}/Users`, {
    headers: { "X-Emby-Token": config.JELLYFIN_API_KEY }
  });
  const needle = username.trim().toLowerCase();
  const exists = users.some((user) => (user.Name ?? "").trim().toLowerCase() === needle);
  return { configured: true, exists };
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

// Newest movies/series by DateCreated - source for the Discord new-content feed.
export async function getRecentlyAddedMedia(limit = 20) {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) {
    return { configured: false as const, items: [] as JellyfinMediaItem[] };
  }
  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const params = new URLSearchParams({
    Recursive: "true",
    IncludeItemTypes: "Movie,Series",
    SortBy: "DateCreated",
    SortOrder: "Descending",
    Fields: "DateCreated,ProductionYear,Overview",
    Limit: String(limit)
  });
  const result = await fetchJson<JellyfinItemsResponse>(`${base}/Items?${params}`, {
    headers: { "X-Emby-Token": config.JELLYFIN_API_KEY }
  });
  return { configured: true as const, items: result.Items ?? [] };
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

// --- Library statistics (for the Discord stat voice-channels) ---

type JellyfinVirtualFolder = {
  Name?: string;
  ItemId?: string;
  CollectionType?: string;
};

type JellyfinItemCounts = {
  MovieCount?: number;
  SeriesCount?: number;
  EpisodeCount?: number;
};

export type LibraryStat = {
  id: string;
  name: string;
  collectionType?: string;
  count: number;
};

export type JellyfinLibraryStats = {
  configured: boolean;
  totals: { movies?: number; series?: number; episodes?: number };
  libraries: LibraryStat[];
};

function includeTypesForCollection(collectionType?: string) {
  switch (collectionType) {
    case "movies":
      return "Movie";
    case "tvshows":
      return "Series";
    case "music":
      return "MusicAlbum";
    case "books":
      return "Book";
    case "musicvideos":
      return "MusicVideo";
    default:
      return undefined;
  }
}

export async function getJellyfinLibraryStats(): Promise<JellyfinLibraryStats> {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) {
    return { configured: false, totals: {}, libraries: [] };
  }

  const base = trimTrailingSlash(config.JELLYFIN_BASE_URL);
  const headers = { "X-Emby-Token": config.JELLYFIN_API_KEY };

  const folders = await fetchJson<JellyfinVirtualFolder[]>(`${base}/Library/VirtualFolders`, { headers });

  const libraries: LibraryStat[] = [];
  for (const folder of folders) {
    if (!folder.ItemId || !folder.Name) continue;
    const params = new URLSearchParams({
      ParentId: folder.ItemId,
      Recursive: "true",
      Limit: "0",
      EnableTotalRecordCount: "true"
    });
    const includeTypes = includeTypesForCollection(folder.CollectionType);
    if (includeTypes) params.set("IncludeItemTypes", includeTypes);
    const result = await fetchJson<JellyfinItemsResponse>(`${base}/Items?${params}`, { headers });
    libraries.push({
      id: folder.ItemId,
      name: folder.Name,
      collectionType: folder.CollectionType,
      count: result.TotalRecordCount ?? result.Items?.length ?? 0
    });
  }

  let totals: JellyfinLibraryStats["totals"] = {};
  try {
    const counts = await fetchJson<JellyfinItemCounts>(`${base}/Items/Counts`, { headers });
    totals = { movies: counts.MovieCount, series: counts.SeriesCount, episodes: counts.EpisodeCount };
  } catch {
    const sumByType = (type: string) =>
      libraries.filter((lib) => lib.collectionType === type).reduce((sum, lib) => sum + lib.count, 0);
    totals = { movies: sumByType("movies") || undefined, series: sumByType("tvshows") || undefined };
  }

  return { configured: true, totals, libraries };
}
