/**
 * React Query hook for the Compaction tab.
 *
 * **Call-scoped.** The hook fetches the set of compaction events that
 * led up to a specific LLM call — not the entire conversation. Picking
 * a different call in the rail produces a different trail (cache key
 * varies on `callId`), so the question "what happened to the context
 * before this call ran?" gets a focused answer.
 *
 * Lazy-load contract: the underlying `queryFn` only fires when the
 * tab is mounted (i.e. selected). Callers should not invoke this from
 * the inspector page root — call it from inside `CompactionTab` so
 * navigation between other tabs (Overview / Prompt / Response / …)
 * never triggers the fetch. `staleTime` matches the rest of the
 * inspector hooks (30s) so re-selecting the tab inside that window
 * serves from cache without a re-fetch.
 *
 * Today the `queryFn` resolves to `fetchCompactionTrailMock`. When
 * the daemon ships a real route, swap the import — the response shape
 * is pinned by `CompactionTrailResponse` in `compaction-trail-types.ts`.
 */

import { queryOptions, useQuery } from "@tanstack/react-query";

import { fetchCompactionTrailMock } from "./compaction-trail-mock";
import type { CompactionTrailResponse } from "./compaction-trail-types";

export class CompactionTrailRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CompactionTrailRequestError";
    this.status = status;
  }
}

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
    queryFn: async ({ signal }): Promise<CompactionTrailResponse> => {
      if (!assistantId) {
        throw new CompactionTrailRequestError(0, "Missing assistantId");
      }
      if (!conversationId) {
        throw new CompactionTrailRequestError(0, "Missing conversationId");
      }
      if (!callId) {
        throw new CompactionTrailRequestError(0, "Missing callId");
      }
      // TODO: replace with real daemon fetch once the route exists:
      //   GET /v1/assistants/{assistantId}/conversations/{conversationId}/compaction
      //     ?callId={callId}
      // Returns the same `CompactionTrailResponse` shape this mock does
      // — see `compaction-trail-types.ts`. The daemon scopes the result
      // server-side to compactions that happened before the call ran.
      return await fetchCompactionTrailMock(conversationId, callId, signal);
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
