/**
 * TanStack Query options for the lightweight `GET /memory/stats` daemon
 * endpoint — a cheap concept-page count for glanceable surfaces (the identity
 * Memory card). Unlike `memoryGraphOptions`, this never triggers the memory
 * concept-graph build; it reads a single count off the cached page index.
 *
 * A 404 (an older assistant predating the route) maps to
 * `{ kind: "unsupported" }` — a success-shaped result, mirroring
 * `memoryGraphOptions` — so callers omit the count entirely rather than showing
 * a wrong "0 memories" (an older daemon may hold plenty of concepts; it just
 * can't count them here). See `docs/BACKWARDS_COMPAT.md`. Other non-2xx /
 * transport errors throw.
 */

import { queryOptions } from "@tanstack/react-query";

import { memoryStatsGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

/**
 * Two-state result mirroring `MemoryGraphResult`. `unsupported` is a
 * success-shaped outcome (the daemon predates the `/memory/stats` route) that
 * callers render as "no count" — not an error, and not a misleading zero.
 *
 * `graphSupported` (on `ready`) reports whether the memory-concept graph is
 * available for this assistant — the cheap capability signal that lets the
 * identity Memory card gate its graph entry point on real availability without
 * building the graph. See the daemon's `graph_supported` on `GET /memory/stats`.
 */
export type MemoryStatsResult =
  | { kind: "ready"; concepts: number; graphSupported: boolean }
  | { kind: "unsupported" };

const FAILURE_MESSAGE = "Failed to load memory stats.";

export function memoryStatsOptions(assistantId: string) {
  return queryOptions<MemoryStatsResult>({
    queryKey: ["memory-stats", assistantId] as const,
    // A glanceable count that only changes on the timescale of memory writes —
    // don't refire it on every window refocus.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MemoryStatsResult> => {
      const { data, error, response } = await memoryStatsGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });

      assertHasResponse(response, error, FAILURE_MESSAGE);

      // An assistant/daemon predating the `/memory/stats` route answers 404;
      // treat that as "not supported here" so the card omits its count instead
      // of showing a wrong 0 (BACKWARDS_COMPAT read rule).
      if (response.status === 404) {
        return { kind: "unsupported" };
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, FAILURE_MESSAGE),
        );
      }

      return {
        kind: "ready",
        concepts: data?.concepts ?? 0,
        // `graph_supported` is absent on daemons predating the field; treat a
        // missing value as "graph not available" so the entry point stays
        // hidden rather than dead-ending on a "not available" graph.
        graphSupported: data?.graph_supported ?? false,
      };
    },
  });
}
