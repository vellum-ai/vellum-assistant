import { type QueryClient, useQuery } from "@tanstack/react-query";

import { listAssistants } from "@/assistant/api";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useRequestOrganizationId } from "@/stores/organization-store";

export type PlatformAvatarUrls = ReadonlyMap<string, string>;

const EMPTY_AVATAR_URLS: PlatformAvatarUrls = new Map();

/** Matches the row-level avatar clocks so a re-synced thumbnail shows within a minute. */
export const PLATFORM_AVATAR_URLS_STALE_TIME_MS = 60_000;

/**
 * Keyed by user and organization: a sign-out never serves another account's
 * thumbnails, and an org switch rescopes the list with the request header.
 */
export function platformAvatarUrlsQueryKey(
  userId: string | null,
  organizationId: string | null,
) {
  return ["platformAvatarUrls", userId, organizationId] as const;
}

const PLATFORM_AVATAR_URLS_KEY_PREFIX = ["platformAvatarUrls"] as const;

/**
 * Per-id tombstones stamped with the fetch generation current at suppression.
 * A list fetch that started at or before the stamp omits the id when it
 * lands; one that started after it is fresher than the suppression and
 * carries the id again, clearing the tombstone.
 */
const suppressedPlatformIds = new Map<string, number>();
let fetchGeneration = 0;

export function resetPlatformAvatarUrlSuppressionsForTests(): void {
  suppressedPlatformIds.clear();
  fetchGeneration = 0;
}

/**
 * Drops one platform id from every cached map without refetching. Mirrors
 * the store's `clearAvatarUrl`: live evidence outranks a URL observed
 * earlier, and the platform copy lags the daemon's async sync, so an
 * immediate refetch would only re-serve the stale URL. The next stale-window
 * refetch restores it. A list in flight keeps its siblings and lands without
 * this id (see the tombstones above); nothing is cancelled.
 */
export function suppressPlatformAvatarUrl(
  queryClient: QueryClient,
  platformAssistantId: string,
): void {
  suppressedPlatformIds.set(platformAssistantId, fetchGeneration);
  queryClient.setQueriesData<PlatformAvatarUrls>(
    { queryKey: PLATFORM_AVATAR_URLS_KEY_PREFIX },
    (urls) => {
      if (!urls?.has(platformAssistantId)) {
        return urls;
      }
      const next = new Map(urls);
      next.delete(platformAssistantId);
      return next;
    },
  );
}

/**
 * Modes where the resolved store is lockfile-driven, so its rows never carry
 * `avatarUrl` and the platform list is only reachable through a side query.
 * Gateway auth has no platform list at all.
 */
export function isLockfileDrivenStore(): boolean {
  return (isLocalClient() || isRemoteGatewayMode()) && !isGatewayAuthEnabled();
}

/** Never throws: a chooser row falls back to its other sources, not an error. */
async function fetchPlatformAvatarUrls(): Promise<PlatformAvatarUrls> {
  const startGeneration = ++fetchGeneration;
  try {
    const result = await listAssistants();
    if (!result.ok) {
      return EMPTY_AVATAR_URLS;
    }
    const urls = new Map<string, string>();
    for (const assistant of result.data) {
      if (
        assistant.avatar_url &&
        !isSuppressed(assistant.id, startGeneration)
      ) {
        urls.set(assistant.id, assistant.avatar_url);
      }
    }
    return urls;
  } catch {
    return EMPTY_AVATAR_URLS;
  }
}

/** Suppressed during or after this fetch; an older tombstone is stale and dropped. */
function isSuppressed(platformAssistantId: string, startGeneration: number) {
  const suppressedAt = suppressedPlatformIds.get(platformAssistantId);
  if (suppressedAt === undefined) {
    return false;
  }
  if (suppressedAt >= startGeneration) {
    return true;
  }
  suppressedPlatformIds.delete(platformAssistantId);
  return false;
}

/**
 * Platform `avatar_url` by assistant id, read-only. One shared query feeds
 * every chooser row, so the list is fetched once per stale window however
 * many rows mount. Enabled only when a live platform session exists in a
 * lockfile-driven mode; elsewhere the resolved store already carries
 * `avatarUrl` and this resolves to an empty map. Never writes the resolved
 * store: `reloadPlatformAssistants` deliberately skips these modes so the
 * API list cannot clobber lockfile rows, and this lookup keeps that contract.
 */
export function usePlatformAvatarUrls(): PlatformAvatarUrls {
  const hasPlatformSession = useHasPlatformSession();
  const userId = useAuthStore.use.user()?.id ?? null;
  const isOrgReady = useIsOrgReady();
  const organizationId = useRequestOrganizationId();
  const query = useQuery<PlatformAvatarUrls>({
    queryKey: platformAvatarUrlsQueryKey(userId, organizationId),
    queryFn: fetchPlatformAvatarUrls,
    enabled: hasPlatformSession && isOrgReady && isLockfileDrivenStore(),
    staleTime: PLATFORM_AVATAR_URLS_STALE_TIME_MS,
    retry: false,
  });
  return query.data ?? EMPTY_AVATAR_URLS;
}
