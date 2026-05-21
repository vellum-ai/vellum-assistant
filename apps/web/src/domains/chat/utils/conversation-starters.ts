import { client } from "@/generated/api/client.gen.js";


import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationStarter {
  id: string;
  label: string;
  prompt: string;
  category: string | null;
  batch: number;
}

export type ConversationStartersStatus =
  | "ready"
  | "refreshing"
  | "empty"
  | "generating";

export interface ListConversationStartersResult {
  starters: ConversationStarter[];
  total: number;
  status: ConversationStartersStatus;
}

interface ListConversationStartersResponse {
  starters?: ConversationStarter[];
  total?: number;
  status?: ConversationStartersStatus;
}

// ---------------------------------------------------------------------------
// SDK base options — same pattern as chat/apps.ts
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 4;
const DEFAULT_OFFSET = 0;
const DEFAULT_SCOPE_ID = "default";

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch the list of conversation starters from the assistant daemon.
 *
 * Hits `GET /v1/assistants/{assistant_id}/conversation-starters` which goes
 * through the wildcard proxy (RuntimeProxyWildcardView) → vembda → container.
 *
 * The daemon returns a deterministic page of suggested prompts plus a status
 * indicator so the UI can show generating/refreshing affordances.
 */
export async function listConversationStarters(
  assistantId: string,
  opts?: { limit?: number; offset?: number; scopeId?: string },
): Promise<ListConversationStartersResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const offset = opts?.offset ?? DEFAULT_OFFSET;
  const scopeId = opts?.scopeId ?? DEFAULT_SCOPE_ID;

  const { data, error, response } = await client.get<
    ListConversationStartersResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/conversation-starters",
    path: { assistant_id: assistantId },
    query: {
      limit: String(limit),
      offset: String(offset),
      scope_id: scopeId,
    },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to list conversation starters.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to list conversation starters.",
    );
    throw new ApiError(response.status, msg);
  }

  return {
    starters: data?.starters ?? [],
    total: data?.total ?? 0,
    status: data?.status ?? "ready",
  };
}
