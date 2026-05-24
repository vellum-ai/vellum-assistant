/**
 * Version gate for feature-flag query freshness.
 *
 * The daemon began broadcasting `sync_changed` with
 * `feature-flags:client` / `feature-flags:assistant` tags in 0.8.5
 * (PR #31921). For assistants on 0.8.5+, push + the `sse.opened`
 * reconnect invalidation keep the flag caches fresh — TanStack's
 * built-in interval poll is redundant.
 *
 * For assistants still on 0.8.4 or older, the daemon has no push
 * path for flags. Those installs need to fall back to the previous
 * polling cadence (5s) at the same call sites that polled before
 * push existed: `useClientFeatureFlagSync` at root, and the
 * Developer panel's observer for assistant flags.
 *
 * The push path uses a moderate `staleTime` (60s) rather than
 * `Infinity` so cross-assistant remounts refetch within a minute —
 * push is assistant-scoped, so the inactive assistant's cache can
 * drift while not viewed.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import { compareParsed, parseSemver } from "@/utils/semver.js";

const MIN_PUSH_VERSION = parseSemver("0.8.5")!;

const POLL_INTERVAL_MS = 5_000;
const PUSH_STALE_MS = 60_000;

/**
 * `true` when the assistant version supports the daemon-side
 * `sync_changed` push path for feature-flag invalidation.
 *
 * Returns `false` when version is unknown (`null` / unparseable) so
 * we fall back to the safe polling behavior until identity resolves.
 *
 * Pre-release tags on the patch version are ignored — `0.8.5-rc.1`
 * counts as 0.8.5 for the purpose of this gate, since the push code
 * lands the moment the patch version bumps to 5.
 */
export function supportsFlagPush(version: string | null): boolean {
  if (!version) return false;
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return compareParsed({ ...parsed, pre: null }, MIN_PUSH_VERSION) >= 0;
}

export interface FlagQueryFreshness {
  staleTime: number;
  refetchInterval: number | false;
}

/**
 * React Query options gated on whether the active assistant's daemon
 * supports push. Wire into `useQuery` via spread:
 *
 *     useQuery({ queryKey, queryFn, ...useFlagQueryFreshness(), ... })
 *
 * Re-renders when `version` flips in the identity store, so TanStack
 * Query reactively cancels the interval poll once a push-capable
 * daemon's identity lands.
 */
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
