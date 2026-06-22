/**
 * React Query hook for the Compaction tab.
 *
 * **Call-scoped.** The hook fetches the set of compaction events that
 * ran in the open window between the previous non-`compactionAgent`
 * LLM call and the selected call — not the entire conversation.
 * Picking a different call in the rail produces a different trail
 * (cache key varies on `callId`), so the question "what did the
 * compactor do to my context before *this specific* call ran?" gets a
 * focused answer.
 *
 * Lazy-load contract: the underlying `queryFn` only fires when the
 * tab is mounted (i.e. selected). Callers should not invoke this from
 * the inspector page root — call it from inside `CompactionTab` so
 * navigation between other tabs (Overview / Prompt / Response / …)
 * never triggers the fetch. `staleTime` matches the rest of the
 * inspector hooks (30s) so re-selecting the tab inside that window
 * serves from cache without a re-fetch.
 */

import { queryOptions, useQuery } from "@tanstack/react-query";

import type { ConversationsByIdCompactionGetResponse } from "@/generated/daemon/types.gen";
import {
  CompactionTrailRequestError,
  fetchCompactionTrail,
} from "./compaction-trail-fetch";

export { CompactionTrailRequestError };

export function compactionTrailQueryOptions(
  assistantId: string | undefined,
  conversationId: string | undefined,
  callId: string | undefined,
) {
  const enabled = Boolean(assistantId && conversationId && callId);
  return queryOptions({
    queryKey: [
      "assistants",
      assistantId,
      "conversations",
      conversationId,
      "compaction",
      { callId },
    ] as const,
    queryFn: async ({
      signal,
    }): Promise<ConversationsByIdCompactionGetResponse> => {
      if (!assistantId) {
        throw new CompactionTrailRequestError(0, "Missing assistantId");
      }
      if (!conversationId) {
        throw new CompactionTrailRequestError(0, "Missing conversationId");
      }
      if (!callId) {
        throw new CompactionTrailRequestError(0, "Missing callId");
      }
      return await fetchCompactionTrail(
        assistantId,
        conversationId,
        callId,
        signal,
      );
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useCompactionTrail(
  assistantId: string | undefined,
  conversationId: string | undefined,
  callId: string | undefined,
) {
  return useQuery(
    compactionTrailQueryOptions(assistantId, conversationId, callId),
  );
}
