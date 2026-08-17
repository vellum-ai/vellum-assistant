import type { QueryClient } from "@tanstack/react-query";

import { memoryGraphOptions } from "./get-memory-graph";
import { memoryStatsOptions } from "./get-memory-stats";

/**
 * Invalidate the two memory reads whose answers are derived from assistant
 * config: `GET /memory-graph` (`supported`) and `GET /memory/stats`
 * (`graph_supported`, `tier`, the concept count).
 *
 * Both carry a 5-minute `staleTime` because they only change on the timescale
 * of memory writes, and both use hand-rolled query keys rather than the
 * generated ones. That combination means a config write that flips
 * `memory.enabled` or `memory.v3.live` leaves the Memory surface showing a
 * pre-write answer for up to five minutes: the assistant is remembering again
 * while the tab still reads "Memory is turned off".
 *
 * Called from the `assistantConfig` sync tag (a config write on any client) and
 * on mount of the unavailable-graph surface, which is where a stale answer is
 * most actively misleading.
 *
 * `refetchType` defaults to TanStack's own default: observed queries refetch
 * now, unobserved ones only go stale. Pass `"none"` to mark stale without
 * issuing any request.
 */
export function invalidateMemoryQueries(
  queryClient: QueryClient,
  assistantId: string,
  refetchType: "active" | "none" = "active",
): void {
  void queryClient.invalidateQueries({
    queryKey: memoryGraphOptions(assistantId).queryKey,
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: memoryStatsOptions(assistantId).queryKey,
    refetchType,
  });
}
