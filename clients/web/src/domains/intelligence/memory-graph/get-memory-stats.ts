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

/** Coarse memory tier, mirroring the daemon's `memoryTier()` buckets. */
export type MemoryTier = "off" | "v1" | "v2" | "v3";

/**
 * Two-state result mirroring `MemoryGraphResult`. `unsupported` is a
 * success-shaped outcome (the daemon predates the `/memory/stats` route) that
 * callers render as "no count" — not an error, and not a misleading zero.
 *
 * `graphSupported` (on `ready`) reports whether the memory-concept graph is
 * available for this assistant — the cheap capability signal that lets the
 * Memory surface decide between drawing the graph and explaining why it can't.
 * See the daemon's `graph_supported` on `GET /memory/stats`.
 *
 * `tier` reports WHY, so the Memory tab can name the actual fix instead of a
 * bare "not available": `"off"` is the user's own Memory opt-out (Settings),
 * `"v1"`/`"v2"` are legacy engines (migrate to v3). It is `undefined` on
 * daemons predating the field, which callers render as neutral copy.
 */
export type MemoryStatsResult =
  | {
      kind: "ready";
      concepts: number;
      graphSupported: boolean;
      tier: MemoryTier | undefined;
    }
  | { kind: "unsupported" };

/**
 * The concept-page count, but only where it is a real measurement — otherwise
 * `undefined`, which glanceable surfaces render as "no count" rather than a
 * number. Concept pages are the v2/v3 substrate: a v1 assistant keeps its
 * memory in the legacy graph and a memory-off one keeps none, so for both the
 * count is a truthful-but-meaningless zero that reads as "I remember nothing
 * about you". Older daemons omit `tier`; fall back to the capability bit,
 * which they do send.
 */
export function conceptPageCount(
  result: MemoryStatsResult | undefined,
): number | undefined {
  if (result?.kind !== "ready") {
    return undefined;
  }
  const hasCorpus = result.tier
    ? result.tier === "v2" || result.tier === "v3"
    : result.graphSupported;
  return hasCorpus ? result.concepts : undefined;
}

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
        // `graph_supported` is absent on daemons predating the field. This
        // replaced the `memory-concept-graph` flag, which was live (on) across
        // all envs — so an older daemon is already showing the graph. During
        // the web-ahead-of-daemon rollout window, default a missing value to
        // `true` (the flag-on behavior) so a live graph is never yanked from a
        // v3 assistant whose daemon hasn't shipped the field yet. Once every
        // daemon reports it, this default never applies and gating is exact.
        graphSupported: data?.graph_supported ?? true,
        // Left undefined on daemons predating the field rather than guessed —
        // a wrong tier would name the wrong fix ("turn Memory back on" at an
        // assistant whose memory is on). Callers fall back to neutral copy.
        tier: data?.tier,
      };
    },
  });
}
