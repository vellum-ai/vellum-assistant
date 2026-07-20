/**
 * TanStack Query options for the lightweight `GET /memory/stats` daemon
 * endpoint — a cheap concept-page count for glanceable surfaces (the identity
 * Memory card). Unlike `memoryGraphOptions`, this never triggers the memory
 * concept-graph build; it reads a single count off the cached page index.
 *
 * A 404 (an older assistant predating the route) degrades to `{ concepts: 0 }`
 * so the card shows "0 memories" rather than an error (see
 * `docs/BACKWARDS_COMPAT.md`). Other non-2xx / transport errors throw.
 */

import { queryOptions } from "@tanstack/react-query";

import { memoryStatsGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export interface MemoryStats {
  concepts: number;
}

const FAILURE_MESSAGE = "Failed to load memory stats.";

export function memoryStatsOptions(assistantId: string) {
  return queryOptions<MemoryStats>({
    queryKey: ["memory-stats", assistantId] as const,
    // A glanceable count that only changes on the timescale of memory writes —
    // don't refire it on every window refocus.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MemoryStats> => {
      const { data, error, response } = await memoryStatsGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });

      assertHasResponse(response, error, FAILURE_MESSAGE);

      // An assistant/daemon predating the `/memory/stats` route answers 404;
      // treat that as an empty memory so the card degrades to "0 memories"
      // instead of an error (BACKWARDS_COMPAT read rule).
      if (response.status === 404) {
        return { concepts: 0 };
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, FAILURE_MESSAGE),
        );
      }

      return { concepts: data?.concepts ?? 0 };
    },
  });
}
