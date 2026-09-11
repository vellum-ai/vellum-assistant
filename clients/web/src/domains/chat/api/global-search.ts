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
  /**
   * Whether message content was a usable source for the conversation results.
   * False means the daemon matched conversation titles only, so a short or
   * empty list says nothing about what the corpus holds and the palette must
   * say so rather than render "no results".
   *
   * Defaults to true on a failed or aborted request: the whole outcome is
   * empty there, and claiming a degraded content lane would explain a
   * transport failure as an index problem.
   */
  contentSearchAvailable: boolean;
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
  contentSearchAvailable: true,
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
      // `?? true` covers a daemon predating the field, matching how
      // `queryTokens` degrades: assume the lane is healthy rather than warn
      // about a degradation this daemon cannot report either way.
      contentSearchAvailable: data.contentSearchAvailable ?? true,
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
