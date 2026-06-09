/**
 * Fetches a single conversation detail from the daemon and transforms
 * it into the client-side `Conversation` shape. Separated from
 * `conversation-queries.ts` so callers like `refreshConversationRow`
 * use this through an import boundary that tests can intercept.
 */

import { conversationsByIdGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { Conversation } from "@/types/conversation-types";

import { detailToConversation } from "./conversation-transforms";

/**
 * Indicates the conversation existed at request time but the server reported
 * it as deleted (HTTP 404). Callers use this sentinel to remove the row from
 * the cached list rather than treat the absence as a transient network error.
 */
export const CONVERSATION_NOT_FOUND = Symbol(
  "vellum.conversation-not-found",
);

export type FetchConversationDetailResult =
  | Conversation
  | typeof CONVERSATION_NOT_FOUND;

/**
 * Fetch a single conversation row in list-row shape. Used by
 * `refreshConversationRow` to GET-and-patch the cached sidebar list.
 *
 * Returns the parsed row, or the `CONVERSATION_NOT_FOUND` sentinel when
 * the server reports the conversation no longer exists.
 */
export async function fetchConversationDetail(
  assistantId: string,
  conversationId: string,
): Promise<FetchConversationDetailResult> {
  const { data, error, response } = await conversationsByIdGet({
    path: { assistant_id: assistantId, id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch conversation.");
  if (response.status === 404) {
    return CONVERSATION_NOT_FOUND;
  }
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch conversation.",
    );
    throw new ApiError(response.status, msg);
  }
  if (!data?.conversation) {
    const bodyPreview = JSON.stringify(data ?? null).slice(0, 200);
    throw new ApiError(
      response.status,
      `Conversation detail payload was malformed (status=${response.status}, body=${bodyPreview}).`,
    );
  }
  return detailToConversation(data.conversation);
}
