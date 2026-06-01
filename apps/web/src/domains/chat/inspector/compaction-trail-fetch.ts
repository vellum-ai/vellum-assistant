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
 * No generated SDK function exists for this route yet (the
 * OpenAPI regen hasn't picked it up). We call `client.get` directly
 * with the URL pattern + path/query params, matching sibling
 * inspector hand-rolled fetchers (`fetchConversationMessages`,
 * `archiveConversation`).
 */

import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/utils/api-errors";

import type { CompactionTrailResponse } from "./compaction-trail-types";

export class CompactionTrailRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CompactionTrailRequestError";
    this.status = status;
  }
}

/**
 * Type guard for the wire shape returned by the assistant route. The
 * `client.get` call is typed but `data` is still `unknown` on the wire
 * — narrow defensively rather than trusting the generic.
 */
function isCompactionTrailResponse(
  value: unknown,
): value is CompactionTrailResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.conversationId === "string" && Array.isArray(v.events);
}

export async function fetchCompactionTrail(
  assistantId: string,
  conversationId: string,
  callId: string,
  signal: AbortSignal | undefined,
): Promise<CompactionTrailResponse> {
  const { data, error, response } = await client.get<
    CompactionTrailResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/conversations/{conversation_id}/compaction",
    path: { assistant_id: assistantId, conversation_id: conversationId },
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
