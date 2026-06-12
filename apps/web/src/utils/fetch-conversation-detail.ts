/**
 * Fetches a single conversation detail from the daemon via
 * `queryClient.fetchQuery` and the generated query-options factory,
 * then transforms it into the client-side `Conversation` shape.
 *
 * Routing through `fetchQuery` gives us TanStack Query deduplication
 * (concurrent fetches for the same conversation collapse into one
 * request) and cache population (the detail response is stored under
 * the generated query key for downstream consumers).
 *
 * A custom `queryFn` (rather than the factory's built-in one) is used
 * because the factory calls `conversationsByIdGet` with
 * `throwOnError: true`, which discards the HTTP status code on errors.
 * The custom queryFn uses `throwOnError: false` so we can distinguish
 * 404 (deleted conversation) from other failures.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery
 * - https://heyapi.dev/openapi-ts/plugins/tanstack-query
 */

import type { QueryClient } from "@tanstack/react-query";

import { conversationsByIdGet } from "@/generated/daemon/sdk.gen";
import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConversationsByIdGetResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { Conversation } from "@/types/conversation-types";

import { detailToConversation } from "./conversation-transforms";

/**
 * Thrown when the daemon reports a conversation as deleted (HTTP 404).
 * Callers catch this to remove the row from the cached list rather
 * than treat the absence as a transient network error.
 */
export class ConversationNotFoundError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

/**
 * Fetch a single conversation detail through TanStack Query's
 * `fetchQuery`, transforming the daemon response into the client-side
 * `Conversation` shape.
 *
 * Throws {@link ConversationNotFoundError} when the server returns 404.
 * Throws {@link ApiError} for other non-OK responses or malformed payloads.
 *
 * `retry` is disabled — the sync pattern provides natural retry via the
 * next `sync_changed` event, and the send-message path benefits from
 * failing fast so the user can retry the action.
 */
export async function fetchConversationDetail(
  queryClient: QueryClient,
  assistantId: string,
  conversationId: string,
): Promise<Conversation> {
  const { queryKey } = conversationsByIdGetOptions({
    path: { assistant_id: assistantId, id: conversationId },
  });

  const data = await queryClient.fetchQuery<ConversationsByIdGetResponse>({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await conversationsByIdGet({
        path: { assistant_id: assistantId, id: conversationId },
        throwOnError: false,
        signal,
      });
      assertHasResponse(response, error, "Failed to fetch conversation.");
      if (response.status === 404) {
        throw new ConversationNotFoundError(conversationId);
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
      return data;
    },
    retry: false,
  });

  return detailToConversation(data.conversation);
}
