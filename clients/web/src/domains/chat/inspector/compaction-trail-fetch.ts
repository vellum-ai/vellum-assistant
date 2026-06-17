/**
 * Real fetcher for the Compaction tab.
 *
 * Talks to the assistant's per-conversation route at
 * `GET /v1/assistants/{assistantId}/conversations/{conversationId}/compaction?callId=…`,
 * routed via the platform's `RuntimeProxyWildcardView`. Handler:
 * `assistant/src/runtime/routes/conversation-compaction-routes.ts`.
 *
 * The assistant scopes the result **server-side** to the open window
 * between the previous non-`compactionAgent` LLM call and the call
 * identified by `callId` — picking a different call in the rail
 * produces a different trail. See the route's doc comment for the
 * floor/ceiling semantics.
 *
 * Calls the generated daemon SDK function `conversationsByIdCompactionGet`,
 * which the platform gateway proxies to the assistant route. The
 * response type is derived from the route's `responseBody` schema.
 */

import { conversationsByIdCompactionGet } from "@/generated/daemon/sdk.gen";
import type { ConversationsByIdCompactionGetResponse } from "@/generated/daemon/types.gen";
import { assertHasResponse } from "@/utils/api-errors";

/** One compaction event row in the trail, oldest first. */
export type CompactionTrailEvent =
  ConversationsByIdCompactionGetResponse["events"][number];

export class CompactionTrailRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CompactionTrailRequestError";
    this.status = status;
  }
}

/**
 * Runtime guard for the wire payload. The daemon route declares a
 * typed `responseBody`, but responses aren't validated against it
 * server-side, so narrow defensively before trusting the shape.
 */
function isCompactionTrailResponse(
  value: unknown,
): value is ConversationsByIdCompactionGetResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.conversationId === "string" && Array.isArray(v.events);
}

export async function fetchCompactionTrail(
  assistantId: string,
  conversationId: string,
  callId: string,
  signal: AbortSignal | undefined,
): Promise<ConversationsByIdCompactionGetResponse> {
  const { data, error, response } = await conversationsByIdCompactionGet({
    path: { assistant_id: assistantId, id: conversationId },
    query: { callId },
    signal,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch compaction trail");
  if (!response.ok) {
    throw new CompactionTrailRequestError(
      response.status,
      `Compaction trail request failed (HTTP ${response.status})`,
    );
  }
  if (!isCompactionTrailResponse(data)) {
    throw new CompactionTrailRequestError(
      0,
      "Compaction trail response was malformed",
    );
  }
  return data;
}
