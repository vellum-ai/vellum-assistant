/**
 * Shared helpers for Firecrawl-compatible scrape/search HTTP APIs
 * (Firecrawl hosted `/v2/*` and fastCRW `/v1/*`).
 */

export const FASTCRW_DEFAULT_API_BASE = "https://api.fastcrw.com";

/**
 * Join an API origin with a path. Empty / whitespace `apiBase` uses
 * `defaultBase`. Trailing slashes on the base are stripped.
 */
export function resolveProviderApiUrl(
  apiBase: string | undefined,
  path: string,
  defaultBase: string,
): string {
  const trimmed = apiBase?.trim() ?? "";
  const origin = (trimmed.length > 0 ? trimmed : defaultBase).replace(
    /\/+$/,
    "",
  );
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

export interface FirecrawlCompatSearchResult {
  title?: string;
  description?: string;
  snippet?: string;
  url?: string;
  category?: string;
}

/**
 * Portable read of Firecrawl / fastCRW search payloads:
 * - grouped: `data.web` (Firecrawl `/v2/search`, hosted CRW with sources)
 * - self-hosted with sources: `data.results.web` (object keyed by source)
 * - self-hosted flat: `data.results` (array)
 * - hosted flat: `data` is the array itself
 */
export function extractFirecrawlCompatSearchResults(
  data: unknown,
): FirecrawlCompatSearchResult[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const root = data as Record<string, unknown>;
  const payload = root.data;

  if (Array.isArray(payload)) {
    return payload as FirecrawlCompatSearchResult[];
  }

  if (payload && typeof payload === "object") {
    const nested = payload as Record<string, unknown>;
    if (Array.isArray(nested.web)) {
      return nested.web as FirecrawlCompatSearchResult[];
    }
    // Self-hosted CRW with sources:["web"] nests rows under data.results.web
    // (an object keyed by source), not data.results as a flat array.
    if (
      nested.results &&
      typeof nested.results === "object" &&
      !Array.isArray(nested.results)
    ) {
      const resultsBySource = nested.results as Record<string, unknown>;
      if (Array.isArray(resultsBySource.web)) {
        return resultsBySource.web as FirecrawlCompatSearchResult[];
      }
      const firstSourceKey = Object.keys(resultsBySource).find((key) =>
        Array.isArray(resultsBySource[key]),
      );
      if (firstSourceKey) {
        return resultsBySource[firstSourceKey] as FirecrawlCompatSearchResult[];
      }
    }
    if (Array.isArray(nested.results)) {
      return nested.results as FirecrawlCompatSearchResult[];
    }
  }

  return [];
}

export function searchResultSnippet(
  result: FirecrawlCompatSearchResult,
): string | undefined {
  const text = result.description || result.snippet;
  return text?.trim() || undefined;
}
