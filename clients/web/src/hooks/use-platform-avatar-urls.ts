import { useQuery } from "@tanstack/react-query";

import { listAssistants } from "@/assistant/api";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";

export type PlatformAvatarUrls = ReadonlyMap<string, string>;

const EMPTY_AVATAR_URLS: PlatformAvatarUrls = new Map();

/** Matches the row-level avatar clocks so a re-synced thumbnail shows within a minute. */
export const PLATFORM_AVATAR_URLS_STALE_TIME_MS = 60_000;

/** Keyed by user so a sign-out never serves another account's thumbnails. */
export function platformAvatarUrlsQueryKey(userId: string | null) {
  return ["platformAvatarUrls", userId] as const;
}

/**
 * Modes where the resolved store is lockfile-driven, so its rows never carry
 * `avatarUrl` and the platform list is only reachable through a side query.
 * Gateway auth has no platform list at all.
 */
function isLockfileDrivenStore(): boolean {
  return (isLocalClient() || isRemoteGatewayMode()) && !isGatewayAuthEnabled();
}

/** Never throws: a chooser row falls back to its other sources, not an error. */
async function fetchPlatformAvatarUrls(): Promise<PlatformAvatarUrls> {
  try {
    const result = await listAssistants();
    if (!result.ok) {
      return EMPTY_AVATAR_URLS;
    }
    const urls = new Map<string, string>();
    for (const assistant of result.data) {
      if (assistant.avatar_url) {
        urls.set(assistant.id, assistant.avatar_url);
      }
    }
    return urls;
  } catch {
    return EMPTY_AVATAR_URLS;
  }
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
  const query = useQuery<PlatformAvatarUrls>({
    queryKey: platformAvatarUrlsQueryKey(userId),
    queryFn: fetchPlatformAvatarUrls,
    enabled: hasPlatformSession && isOrgReady && isLockfileDrivenStore(),
    staleTime: PLATFORM_AVATAR_URLS_STALE_TIME_MS,
    retry: false,
  });
  return query.data ?? EMPTY_AVATAR_URLS;
}
