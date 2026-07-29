/**
 * Backwards-compat gates for feature-flag query freshness.
 *
 * Vellum Assistant 0.8.5 introduced `sync_changed` broadcasts for the
 * feature-flag tags (PR #31921 / #31932). Web subscribers use those pushes
 * and `sse.opened` reconnect invalidation to keep flag query caches fresh.
 *
 * Assistants on 0.8.4 or older have no push path for flags. They retain the
 * 5-second poll so values still converge. Push-capable client flags with an
 * attached sync transport stay fresh indefinitely until an explicit
 * invalidation, while assistant flags use a 60-second stale window for their
 * existing remount behavior.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.5";

const POLL_INTERVAL_MS = 5_000;
const PUSH_STALE_MS = 60_000;

export interface FlagQueryFreshness {
  staleTime: number;
  refetchInterval: number | false;
}

function useFlagQueryFreshnessFor(
  pushStaleTime: number,
  hasSyncTransport = true,
): FlagQueryFreshness {
  const supportsPush = useAssistantSupports(MIN_VERSION);
  if (supportsPush && hasSyncTransport) {
    return { staleTime: pushStaleTime, refetchInterval: false };
  }
  return {
    staleTime: POLL_INTERVAL_MS,
    refetchInterval: POLL_INTERVAL_MS,
  };
}

export function useFlagQueryFreshness(): FlagQueryFreshness {
  return useFlagQueryFreshnessFor(PUSH_STALE_MS);
}

export function useClientFlagQueryFreshness(
  hasSyncTransport: boolean,
): FlagQueryFreshness {
  return useFlagQueryFreshnessFor(Infinity, hasSyncTransport);
}
