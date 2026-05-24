/**
 * Backwards-compat gate: feature-flag query freshness.
 *
 * Daemon 0.8.5 introduced `sync_changed` broadcasts for the two
 * feature-flag tags (PR #31921 / #31932). Web subscribers use those
 * pushes + `sse.opened` reconnect invalidation to keep the flag query
 * caches fresh, so the previous 5s interval poll is redundant.
 *
 * Daemons on 0.8.4 or older have no push path for flags — they still
 * need the poll to stay live.
 *
 * `useFlagQueryFreshness()` returns the right TanStack Query options
 * for the active assistant. Spread into `useQuery`.
 *
 * Delete this module (and the surrounding directory if it becomes
 * empty) once 0.8.4 falls out of support.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import { assistantSupports } from "@/lib/backwards-compat/utils.js";

const MIN_FLAG_PUSH_VERSION = "0.8.5";

const POLL_INTERVAL_MS = 5_000;
const PUSH_STALE_MS = 60_000;

/**
 * Exposed for testing and for any caller that needs the same gate
 * without the React-Query option shape.
 */
export function supportsFlagPush(version: string | null): boolean {
  return assistantSupports(version, MIN_FLAG_PUSH_VERSION);
}

export interface FlagQueryFreshness {
  staleTime: number;
  refetchInterval: number | false;
}

export function useFlagQueryFreshness(): FlagQueryFreshness {
  const version = useAssistantIdentityStore.use.version();
  if (supportsFlagPush(version)) {
    return { staleTime: PUSH_STALE_MS, refetchInterval: false };
  }
  return {
    staleTime: POLL_INTERVAL_MS,
    refetchInterval: POLL_INTERVAL_MS,
  };
}
