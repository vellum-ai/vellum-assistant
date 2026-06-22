import { searchGlobalGet } from "@/generated/daemon/sdk.gen";
import type { SearchGlobalGetResponse } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Search results grouped by category, as returned by the daemon's
 * `GET /v1/search/global` endpoint. Re-exported from the generated SDK types
 * so consumers import from the domain module, not `@/generated/` directly.
 */
export type GlobalSearchResponse = SearchGlobalGetResponse["results"];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const EMPTY_RESULTS: GlobalSearchResponse = {
  conversations: [],
  memories: [],
  schedules: [],
  contacts: [],
};

/**
 * Perform a global search across the daemon's indexed data for the given
 * assistant. Returns results grouped by category.
 *
 * Gracefully returns empty results on failure (logs to Sentry).
 */
export async function searchGlobal(
  assistantId: string,
  query: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<GlobalSearchResponse> {
  const limit = options?.limit ?? 20;

  try {
    const { data, response } = await searchGlobalGet({
      path: { assistant_id: assistantId },
      query: {
        q: query,
        limit,
        categories: "conversations,schedules,contacts",
      },
      throwOnError: false,
      signal: options?.signal,
    });

    if (!response?.ok || !data) {
      return EMPTY_RESULTS;
    }

    return data.results;
  } catch (err) {
    // AbortError is expected when debounced queries supersede each other.
    if (err instanceof DOMException && err.name === "AbortError") {
      return EMPTY_RESULTS;
    }
    console.error("[global-search] search failed", { assistantId, query, err });
    return EMPTY_RESULTS;
  }
}
