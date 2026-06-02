import { searchGlobalGet } from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Search results grouped by category, as returned by the daemon.
 *
 * The generated `SearchGlobalGetResponse["results"]` type resolves to
 * `{ [key: string]: unknown }` because HeyAPI collapses the inline nested
 * object despite the spec having full property definitions. This interface
 * mirrors the Zod schemas in `assistant/src/runtime/routes/global-search-routes.ts`
 * (lines 34–76) so consumers get proper type safety.
 */
export interface GlobalSearchResponse {
  conversations: Array<{
    id: string;
    title: string | null;
    updatedAt: number;
    excerpt: string;
    matchCount: number;
  }>;
  memories: Array<{
    id: string;
    kind: string;
    text: string;
    subject: string | null;
    confidence: number;
    updatedAt: number;
    source: "lexical" | "semantic";
  }>;
  schedules: Array<{
    id: string;
    name: string;
    expression: string | null;
    message: string;
    enabled: boolean;
    nextRunAt: number | null;
  }>;
  contacts: Array<{
    id: string;
    displayName: string;
    notes: string | null;
    lastInteraction: number | null;
  }>;
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

    return data.results as unknown as GlobalSearchResponse;
  } catch (err) {
    // AbortError is expected when debounced queries supersede each other.
    if (err instanceof DOMException && err.name === "AbortError") {
      return EMPTY_RESULTS;
    }
    console.error("[global-search] search failed", { assistantId, query, err });
    return EMPTY_RESULTS;
  }
}
