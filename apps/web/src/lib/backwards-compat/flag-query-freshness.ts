/**
 * Backwards-compat gate: feature-flag query freshness.
 *
 * Vellum Assistant 0.8.5 introduced `sync_changed` broadcasts for the
 * two feature-flag tags (PR #31921 / #31932). Web subscribers use
 * those pushes + `sse.opened` reconnect invalidation to keep the flag
 * query caches fresh, so the previous 5s interval poll is redundant.
 *
 * Assistants on 0.8.4 or older have no push path for flags. They still
 * need the poll to stay live.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.5";

const POLL_INTERVAL_MS = 5_000;
const PUSH_STALE_MS = 60_000;

export interface FlagQueryFreshness {
  staleTime: number;
  refetchInterval: number | false;
}

export function useFlagQueryFreshness(): FlagQueryFreshness {
  const supportsPush = useAssistantSupports(MIN_VERSION);
  if (supportsPush) {
    return { staleTime: PUSH_STALE_MS, refetchInterval: false };
  }
  return {
    staleTime: POLL_INTERVAL_MS,
    refetchInterval: POLL_INTERVAL_MS,
  };
}
