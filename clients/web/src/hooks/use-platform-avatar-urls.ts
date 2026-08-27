import { type QueryClient, useQuery } from "@tanstack/react-query";

import { listAssistants } from "@/assistant/api";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import {
  isAvatarSuperseded,
  markAvatarSuperseded,
} from "@/lib/avatar-supersede";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
import {
  resolvePlatformAssistantId,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";

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
 * Drops one platform id from every cached map without refetching and marks
 * it superseded (see `avatar-supersede`): live evidence outranks a URL
 * observed earlier, and the platform copy lags the daemon's async sync, so
 * an immediate refetch would only re-serve the stale URL. A list in flight
 * keeps its siblings and lands without this id; nothing is cancelled. The
 * first refetch after the window restores it.
 */
export function suppressPlatformAvatarUrl(
  queryClient: QueryClient,
  platformAssistantId: string,
): void {
  markAvatarSuperseded(platformAssistantId);
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
 * Everything a fresher local avatar read outranks for `assistantId`: the
 * row's synced `avatarUrl` and its platform lookup entry. A paired row keyed
 * by its local slug is also suppressed under its platform UUID once the
 * paired daemon answers, since that is the key the list carries.
 */
export function supersedePlatformAvatar(
  queryClient: QueryClient,
  assistantId: string,
): void {
  const store = useResolvedAssistantsStore.getState();
  store.clearAvatarUrl(assistantId);
  suppressPlatformAvatarUrl(
    queryClient,
    resolvePlatformAssistantId(assistantId),
  );
  const row = store.assistants.find((a) => a.id === assistantId);
  if (row?.isPaired && !row.platformAssistantId) {
    // Dynamic: the resolver reaches the auth store, which reaches this
    // module through the avatar hooks.
    void import("@/lib/paired-platform-identity")
      .then((m) => m.resolvePairedAssistantPlatformId(assistantId))
      .then((platformId) => {
        if (platformId) {
          suppressPlatformAvatarUrl(queryClient, platformId);
        }
      });
  }
}

/**
 * Modes where the resolved store is lockfile-driven, so its rows never carry
 * `avatarUrl` and the platform list is only reachable through a side query.
 * Gateway auth has no platform list at all.
 */
export function isLockfileDrivenStore(): boolean {
  return (isLocalClient() || isRemoteGatewayMode()) && !isGatewayAuthEnabled();
}

/**
 * Throws on failure so React Query keeps the last good map through a failed
 * poll; with no prior data the hook reads that as an empty map, and a
 * chooser row falls back to its other sources, never an error.
 */
async function fetchPlatformAvatarUrls(): Promise<PlatformAvatarUrls> {
  const result = await listAssistants();
  if (!result.ok) {
    throw new Error(`Failed to list assistants (${result.status})`);
  }
  const urls = new Map<string, string>();
  for (const assistant of result.data) {
    if (assistant.avatar_url && !isAvatarSuperseded(assistant.id)) {
      urls.set(assistant.id, assistant.avatar_url);
    }
  }
  return urls;
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
    // staleTime alone never refetches a chooser that stays mounted, and a
    // sibling's change on another client sends no event here; poll while
    // the window is in the foreground.
    refetchInterval: PLATFORM_AVATAR_URLS_STALE_TIME_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return query.data ?? EMPTY_AVATAR_URLS;
}
