/**
 * React Query hook for the Compaction Trail tab.
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
 * the daemon ships a real `GET /v1/conversations/:id/compaction-trail`
 * route, swap the import — the response shape is pinned by
 * `CompactionTrailResponse` in `compaction-trail-types.ts`.
 */

import { queryOptions, useQuery } from "@tanstack/react-query";

import { fetchCompactionTrailMock } from "./compaction-trail-mock.js";
import type { CompactionTrailResponse } from "./compaction-trail-types.js";

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
) {
  const enabled = Boolean(assistantId && conversationId);
  return queryOptions({
    queryKey: [
      "assistants",
      assistantId,
      "conversations",
      conversationId,
      "compaction-trail",
    ] as const,
    queryFn: async ({ signal }): Promise<CompactionTrailResponse> => {
      if (!assistantId) {
        throw new CompactionTrailRequestError(0, "Missing assistantId");
      }
      if (!conversationId) {
        throw new CompactionTrailRequestError(0, "Missing conversationId");
      }
      // TODO: replace with real daemon fetch once the route exists:
      //   GET /v1/assistants/{assistantId}/conversations/{conversationId}/compaction-trail
      // Returns the same `CompactionTrailResponse` shape this mock does
      // — see `compaction-trail-types.ts`.
      return await fetchCompactionTrailMock(conversationId, signal);
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useCompactionTrail(
  assistantId: string | undefined,
  conversationId: string | undefined,
) {
  return useQuery(compactionTrailQueryOptions(assistantId, conversationId));
}
