import { conversationstartersGet } from "@/generated/daemon/sdk.gen";
import type { ConversationstartersGetResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single conversation starter chip, as returned by the daemon. */
export type ConversationStarter =
  ConversationstartersGetResponse["starters"][number];

export type ConversationStartersStatus =
  ConversationstartersGetResponse["status"];

export interface ListConversationStartersResult {
  starters: ConversationStarter[];
  total: number;
  status: ConversationStartersStatus;
}

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

  const { data, error, response } = await conversationstartersGet({
    path: { assistant_id: assistantId },
    query: {
      limit,
      offset,
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
