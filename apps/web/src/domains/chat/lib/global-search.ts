
import { client } from "@/generated/api/client.gen.js";

// Import for side effects to configure the default HeyAPI client.
import "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalSearchConversation {
  id: string;
  title: string | null;
  updatedAt: number;
  excerpt: string;
  matchCount: number;
}

interface GlobalSearchSchedule {
  id: string;
  name: string;
  cronExpression: string;
  nextRunAt: number | null;
  enabled: boolean;
}

interface GlobalSearchContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface GlobalSearchResponse {
  conversations: GlobalSearchConversation[];
  schedules: GlobalSearchSchedule[];
  contacts: GlobalSearchContact[];
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

const EMPTY_RESULTS: GlobalSearchResponse = {
  conversations: [],
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
    const { data, response } = await client.get<GlobalSearchResponse, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/search/global",
      path: { assistant_id: assistantId },
      query: {
        q: query,
        limit,
        categories: "conversations,schedules,contacts",
      },
      throwOnError: false,
      signal: options?.signal,
    });

    if (!response?.ok) {
      return EMPTY_RESULTS;
    }

    // Validate the shape minimally — the daemon may evolve its response.
    if (data && typeof data === "object") {
      return {
        conversations: Array.isArray((data as GlobalSearchResponse).conversations)
          ? (data as GlobalSearchResponse).conversations
          : [],
        schedules: Array.isArray((data as GlobalSearchResponse).schedules)
          ? (data as GlobalSearchResponse).schedules
          : [],
        contacts: Array.isArray((data as GlobalSearchResponse).contacts)
          ? (data as GlobalSearchResponse).contacts
          : [],
      };
    }

    return EMPTY_RESULTS;
  } catch (err) {
    // AbortError is expected when debounced queries supersede each other.
    if (err instanceof DOMException && err.name === "AbortError") {
      return EMPTY_RESULTS;
    }
    console.error("[global-search] search failed", { assistantId, query, err });
    return EMPTY_RESULTS;
  }
}
