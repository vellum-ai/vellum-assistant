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

/**
 * A search outcome: the results plus the term the daemon actually matched
 * on (the input with supported filters like `is:archived` stripped) and
 * its lexical tokens from the daemon's own tokenizer.
 */
export interface GlobalSearchOutcome {
  query: string;
  queryTokens: string[];
  results: GlobalSearchResponse;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const EMPTY_RESULTS: GlobalSearchResponse = {
  conversations: [],
  memories: [],
  schedules: [],
  contacts: [],
};

const EMPTY_OUTCOME: GlobalSearchOutcome = {
  query: "",
  queryTokens: [],
  results: EMPTY_RESULTS,
};

/** Whitespace-token fallback for daemons that predate `queryTokens`. */
function tokensWithFallback(
  tokens: string[] | undefined,
  query: string,
): string[] {
  if (tokens) {
    return tokens;
  }
  return query.split(/\s+/).filter((token) => token.length > 0);
}

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
): Promise<GlobalSearchOutcome> {
  const limit = options?.limit ?? 10;

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
      return EMPTY_OUTCOME;
    }

    return {
      query: data.query,
      queryTokens: tokensWithFallback(data.queryTokens, data.query),
      results: data.results,
    };
  } catch (err) {
    // AbortError is expected when debounced queries supersede each other.
    if (err instanceof DOMException && err.name === "AbortError") {
      return EMPTY_OUTCOME;
    }
    console.error("[global-search] search failed", { assistantId, query, err });
    return EMPTY_OUTCOME;
  }
}
