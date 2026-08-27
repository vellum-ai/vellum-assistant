import { useCallback, useState } from "react";
import { type QueryClient, useQuery } from "@tanstack/react-query";

import { fetchAvatarState } from "@/assistant/avatar-api";
import {
  type LegacyAvatarRead,
  avatarQueryKey,
  fetchAvatarViaManifest,
  readAvatarViaLegacyFiles,
  releaseAssistantAvatarUrl,
  resolveAvatarFromState,
  useAssistantAvatar,
} from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  isLockfileDrivenStore,
  usePlatformAvatarUrls,
} from "@/hooks/use-platform-avatar-urls";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import {
  deleteLastSeenAvatar,
  readLastSeenAvatar,
} from "@/lib/avatar-last-seen-cache";
import { versionSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { trackBlobUrl } from "@/lib/blob-url-tracker";
import { lastSeenAvatarGenerations } from "@/lib/avatar-last-seen-cache";
import { createGenerationGuard } from "@/lib/generation-guard";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { resolvePairedAssistantPlatformId } from "@/lib/paired-platform-identity";
import {
  chooserRowAvatarCacheQueryKey,
  persistLastSeenAvatar,
} from "@/lib/persist-last-seen-avatar";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import {
  canReadAvatarFromLocalHost,
  readAssistantAvatarHost,
} from "@/runtime/local-mode-host";
import { useHasPlatformSession } from "@/stores/auth-store";
import {
  type ResolvedAssistant,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";
import type { AvatarRead } from "@/types/avatar";

const QUERY_KEY_PREFIX = "chooserRowAvatar";

export interface ChooserRowAvatar extends AvatarRead {
  /**
   * Wire to the rendered image's `onError`. A platform thumbnail that fails
   * to load (offline, expired signed URL) re-enables the row's other sources.
   */
  onImageError: () => void;
}

type RowManifestSupport = "supported" | "unsupported" | "unknown";

/**
 * Tri-state manifest gate for a row's own runtime. Part of the query key so
 * a version change after an upgrade re-runs the fetch through the other path.
 */
function rowManifestSupport(assistant: ResolvedAssistant): RowManifestSupport {
  const version =
    assistant.runtimeVersion ?? assistant.currentReleaseVersion ?? null;
  if (version === null) {
    return "unknown";
  }
  return versionSupportsAvatarStateManifest(version)
    ? "supported"
    : "unsupported";
}

/** Prefix matching every support-state variant of one row; use for invalidation. */
export function chooserRowAvatarQueryKeyPrefix(assistantId: string) {
  return [QUERY_KEY_PREFIX, assistantId] as const;
}

function chooserRowAvatarQueryKey(
  assistantId: string,
  manifestSupport: RowManifestSupport,
) {
  return [
    ...chooserRowAvatarQueryKeyPrefix(assistantId),
    manifestSupport,
  ] as const;
}

/** Under the row prefix so the avatar-sync invalidation covers it too. */
function chooserRowAvatarHostQueryKey(assistantId: string) {
  return [...chooserRowAvatarQueryKeyPrefix(assistantId), "host"] as const;
}

const EMPTY_AVATAR: AvatarRead = { traits: null, imageUrl: null };

/**
 * A bare avatar is the state most likely to change soon (a fresh assistant
 * gets one during onboarding), and a legacy transport failure also lands
 * here. Let it go stale on a normal clock instead of pinning the glyph.
 */
const EMPTY_AVATAR_STALE_TIME_MS = 60_000;

/**
 * A host read is a disk snapshot with no invalidation signal for a sibling
 * assistant (only the active one broadcasts resource changes), so let it age
 * out on a clock: re-read when the chooser is shown again, and poll at the
 * same cadence while it stays mounted in the foreground.
 */
const HOST_AVATAR_STALE_TIME_MS = 60_000;

/** Separate from `use-assistant-avatar`'s map so the two caches never revoke each other's URLs. */
const activeBlobUrls = new Map<string, string>();

/** Object URLs minted from cached Blobs; kept apart so a live fetch never revokes a cached URL. */
const cachedBlobUrls = new Map<string, string>();

/** Latest fetch generation per row; a superseded fetch must not touch the map. */
const fetchGenerations = createGenerationGuard();

/**
 * Revoke every object URL held for a removed assistant, across this module's
 * maps and the live hook's, and drop the query entries that hold those
 * (now dead) `blob:` strings, or re-pairing the same id within gcTime would
 * render a revoked image. Supersedes any in-flight row fetch so it drops its
 * own blob instead of re-registering one and re-persisting the entry.
 */
function releaseRowAvatarUrls(
  queryClient: QueryClient,
  assistantId: string,
): void {
  fetchGenerations.invalidate(assistantId);
  trackBlobUrl(activeBlobUrls, assistantId, null);
  trackBlobUrl(cachedBlobUrls, assistantId, null);
  releaseAssistantAvatarUrl(assistantId);
  for (const queryKey of [
    chooserRowAvatarQueryKeyPrefix(assistantId),
    chooserRowAvatarCacheQueryKey(assistantId),
    avatarQueryKey(assistantId),
  ]) {
    queryClient.removeQueries({ queryKey });
  }
}

/** Full avatar cleanup for an assistant leaving this device: cache entry, URLs, queries. */
export function forgetAssistantAvatar(
  queryClient: QueryClient,
  assistantId: string,
): void {
  void deleteLastSeenAvatar(assistantId);
  releaseRowAvatarUrls(queryClient, assistantId);
}

/**
 * Whether a daemon SDK call for `row` actually reaches `row`'s runtime.
 *
 * The SDK targets `/v1/assistants/{id}/...`, and only the platform proxy
 * routes by that id. Every other transport pins the request to ONE
 * assistant regardless of the id in the path, so a fetch for a sibling
 * row would answer with the connected assistant's avatar (or 404):
 * - local / remote-gateway / gateway-auth clients talk to a single gateway;
 * - a self-hosted ingress (`getSelfHostedIngressUrl()`) makes the request
 *   interceptor rewrite every daemon call to that gateway, whose
 *   runtime-proxy discards the id;
 * - local and paired rows have no per-id platform route at all.
 */
export function canFetchRowAvatarViaPlatformProxy(
  row: ResolvedAssistant,
): boolean {
  return (
    !isLocalClient() &&
    !isRemoteGatewayMode() &&
    !isGatewayAuthEnabled() &&
    getSelfHostedIngressUrl() === null &&
    row.isPlatformHosted
  );
}

/**
 * Whether the host can read `row`'s avatar off its workspace on disk.
 * `cloud` is only ever set from the lockfile, so `"local"` means the
 * assistant lives on this machine; docker and paired rows have no workspace
 * the host can read.
 */
function canReadRowAvatarViaHost(row: ResolvedAssistant): boolean {
  return row.cloud === "local" && canReadAvatarFromLocalHost();
}

/**
 * Whether `row` should consult {@link usePlatformAvatarUrls}: the store is
 * lockfile-driven, so no row kind carries `avatarUrl` (platform-hosted rows
 * included, since `reloadPlatformAssistants` skips the API write there) and
 * the thumbnail is only reachable by platform id. A row that does carry one
 * renders it directly. Pure cloud mode never gets here: the lookup query is
 * disabled and the map stays empty.
 */
function canLookUpRowAvatarByPlatformId(row: ResolvedAssistant): boolean {
  return !row.avatarUrl && isLockfileDrivenStore();
}

/** Under the row prefix so `forgetAssistantAvatar` drops it with the rest. */
function pairedPlatformIdQueryKey(assistantId: string, runtimeUrl?: string) {
  return [
    ...chooserRowAvatarQueryKeyPrefix(assistantId),
    "platformId",
    runtimeUrl ?? null,
  ] as const;
}

/**
 * The id to look `row` up by in the platform list. A platform-hosted row's
 * `id` is its UUID; a local row's is `platformAssistantId`; a paired row's
 * lockfile entry starts without one, so it is resolved lazily from the paired
 * daemon and persisted (see {@link resolvePairedAssistantPlatformId}). Until
 * that lands the row falls through to its other sources.
 */
function usePlatformLookupId(
  row: ResolvedAssistant,
  canLookUp: boolean,
): string | null {
  const hasPlatformSession = useHasPlatformSession();
  const needsPairedResolve =
    row.isPaired && !row.platformAssistantId && canLookUp;
  const pairedQuery = useQuery<string | null>({
    queryKey: pairedPlatformIdQueryKey(row.id, row.runtimeUrl),
    queryFn: () => resolvePairedAssistantPlatformId(row.id),
    enabled: needsPairedResolve && hasPlatformSession,
    // A miss goes stale so a later mount or resume probes again.
    staleTime: (query) =>
      query.state.data ? Infinity : EMPTY_AVATAR_STALE_TIME_MS,
    refetchOnWindowFocus: (query) => !query.state.data,
    retry: false,
  });
  if (row.platformAssistantId) {
    return row.platformAssistantId;
  }
  return row.isPaired ? (pairedQuery.data ?? null) : row.id;
}

function conclusive(read: AvatarRead): LegacyAvatarRead {
  return { ...read, conclusive: true };
}

/**
 * A data URL sidesteps blob lifecycle management for host-sourced bytes.
 * A successful read with no avatar is a conclusive none that evicts the
 * last-seen entry; `ok: false` is not. Host-disk reads are durable, so a
 * found avatar never feeds the cache.
 */
async function readRowAvatarViaHost(
  queryClient: QueryClient,
  assistantId: string,
): Promise<LegacyAvatarRead> {
  // Peeked, not claimed, so the read never cancels an in-flight live persist;
  // a live persist that lands mid-flight still outranks a stale host "none".
  const generation = lastSeenAvatarGenerations.current(assistantId);
  const result = await readAssistantAvatarHost(assistantId);
  if (!result.ok) {
    return { ...EMPTY_AVATAR, conclusive: false };
  }
  if (result.avatar === null) {
    if (lastSeenAvatarGenerations.isCurrent(assistantId, generation)) {
      void persistLastSeenAvatar(queryClient, assistantId, EMPTY_AVATAR);
    }
    return conclusive(EMPTY_AVATAR);
  }
  return conclusive(
    result.avatar.kind === "character"
      ? { traits: result.avatar.traits, imageUrl: null }
      : {
          traits: null,
          imageUrl: `data:image/png;base64,${result.avatar.imageBase64}`,
        },
  );
}

/**
 * Manifest reads for runtimes known to serve `/avatar/state`; legacy sidecar
 * reads for runtimes known not to (an unknown version probes the manifest
 * first). The platform proxy answers 404 for an asleep sibling, so two
 * sidecar 404s cannot be told from an unreachable runtime: an empty sidecar
 * read is inconclusive here. A manifest that promises an image whose
 * content fails throws (never a false "none").
 */
async function fetchRowAvatar(
  assistant: ResolvedAssistant,
  manifestSupport: RowManifestSupport,
): Promise<LegacyAvatarRead> {
  if (manifestSupport === "supported") {
    return conclusive(await fetchAvatarViaManifest(assistant.id));
  }
  if (manifestSupport === "unknown") {
    const state = await fetchAvatarState(assistant.id);
    if (state !== null) {
      return conclusive(await resolveAvatarFromState(assistant.id, state));
    }
  }
  const legacy = await readAvatarViaLegacyFiles(assistant.id);
  return isEmptyAvatar(legacy) ? { ...legacy, conclusive: false } : legacy;
}

/**
 * Runs one fetch generation for `assistant`. A re-key (manifest support
 * flipping) can start a newer fetch while this one is in flight; when the
 * older one finishes last it must not revoke the URL the newer query renders,
 * so it drops its own blob instead. A conclusive read is what the row falls
 * back to once the assistant is unreachable, so it feeds the last-seen cache.
 */
async function fetchRowAvatarGeneration(
  queryClient: QueryClient,
  assistant: ResolvedAssistant,
  manifestSupport: RowManifestSupport,
): Promise<LegacyAvatarRead> {
  const generation = fetchGenerations.claim(assistant.id);
  const avatar = await fetchRowAvatar(assistant, manifestSupport);
  if (!fetchGenerations.isCurrent(assistant.id, generation)) {
    if (avatar.imageUrl) {
      URL.revokeObjectURL(avatar.imageUrl);
    }
    return { ...avatar, imageUrl: null };
  }
  trackBlobUrl(activeBlobUrls, assistant.id, avatar.imageUrl);
  if (avatar.conclusive) {
    void persistLastSeenAvatar(queryClient, assistant.id, avatar);
  }
  return avatar;
}

function isEmptyAvatar(avatar: AvatarRead | undefined): boolean {
  return avatar !== undefined && !avatar.traits && !avatar.imageUrl;
}

async function readCachedRowAvatar(assistantId: string): Promise<AvatarRead> {
  const cached = await readLastSeenAvatar(assistantId);
  const imageUrl =
    cached?.kind === "image" ? URL.createObjectURL(cached.blob) : null;
  trackBlobUrl(cachedBlobUrls, assistantId, imageUrl);
  return {
    traits: cached?.kind === "character" ? cached.traits : null,
    imageUrl,
  };
}

/**
 * Avatar data for one chooser row, resolved through a precedence chain:
 * 1. The connected row reuses `useAssistantAvatar`'s cache, correct in every
 *    transport mode and never fetched twice.
 * 2. The platform's synced thumbnail (`assistant.avatarUrl`): a plain image
 *    URL, so it renders in every mode with no daemon round-trip. It ranks
 *    below 1 because the live read keeps a character avatar's SVG fidelity.
 * 3. Other platform rows fetch per id through the platform proxy, only when
 *    {@link canFetchRowAvatarViaPlatformProxy} says the id is honored and the
 *    org store can supply the `Vellum-Organization-Id` header.
 * 4. Local rows (the connected one when unreachable, siblings even asleep)
 *    read their workspace through the host when one can serve it.
 * 5. Every row without `avatarUrl` in a lockfile-driven mode looks its
 *    platform id up in the platform list (`usePlatformAvatarUrls`): lockfile
 *    rows never carry `avatarUrl`, so this is how a logged-in desktop shows a
 *    sibling's synced thumbnail. A paired row first resolves its platform
 *    UUID from the paired daemon (`usePlatformLookupId`).
 * 6. The last-seen cache: whatever a live source last resolved for this id,
 *    so a row keeps its avatar while the assistant is unreachable.
 * Only live sources (1 and 3) feed the cache, at fetch time (1 does so
 * inside `useAssistantAvatar`); a conclusive none from any source evicts it.
 * Persisting live evidence also drops the row's `avatarUrl`, so 2 never
 * outranks a fresher local read. A platform URL (2 or 5) that fails to load
 * (`onImageError`) is set aside so the sources below it take over for that
 * row, until the next `app.resume` (network back, window foregrounded)
 * retries it.
 * Anything else, including every failure, resolves to nulls: the row's glyph
 * fallback is the error state, a chooser row never surfaces an error.
 */
export function useChooserRowAvatar(
  assistant: ResolvedAssistant,
): ChooserRowAvatar {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isConnectedRow = assistant.id === activeAssistantId;
  const isOrgReady = useIsOrgReady();

  const connected = useAssistantAvatar(isConnectedRow ? assistant.id : null);

  // Keyed by URL so a reload that carries a new thumbnail retries it; a
  // resume retries the same URL, since the failure may have been offline.
  const [failedPlatformUrl, setFailedPlatformUrl] = useState<string | null>(
    null,
  );
  useBusSubscription("app.resume", () => setFailedPlatformUrl(null));
  const syncedUrl =
    assistant.avatarUrl && assistant.avatarUrl !== failedPlatformUrl
      ? assistant.avatarUrl
      : null;
  const syncedAvatar: AvatarRead | null = syncedUrl
    ? { traits: null, imageUrl: syncedUrl }
    : null;
  const hasSyncedAvatar = syncedAvatar !== null;

  const manifestSupport = rowManifestSupport(assistant);
  const rowQuery = useQuery<LegacyAvatarRead>({
    queryKey: chooserRowAvatarQueryKey(assistant.id, manifestSupport),
    queryFn: ({ client }) =>
      fetchRowAvatarGeneration(client, assistant, manifestSupport),
    enabled:
      !isConnectedRow &&
      !hasSyncedAvatar &&
      isOrgReady &&
      canFetchRowAvatarViaPlatformProxy(assistant),
    staleTime: (query) =>
      isEmptyAvatar(query.state.data) ? EMPTY_AVATAR_STALE_TIME_MS : Infinity,
    structuralSharing: false,
    // A rejected query leaves `data` undefined, which reads as nulls below.
    retry: 1,
  });

  // A live source is conclusive once its query succeeded through a path
  // that cannot mistake a failure for a bare avatar (useAssistantAvatar
  // throws on every inconclusive read); on error React Query keeps prior
  // data, which is still worth rendering but not caching.
  const live: AvatarRead | undefined = isConnectedRow
    ? { traits: connected.traits, imageUrl: connected.customImageUrl }
    : rowQuery.data && {
        traits: rowQuery.data.traits,
        imageUrl: rowQuery.data.imageUrl,
      };
  const liveConclusive = isConnectedRow
    ? connected.isSuccess
    : rowQuery.isSuccess && rowQuery.data.conclusive;
  const showLive =
    liveConclusive || (live !== undefined && !isEmptyAvatar(live));

  // The connected row only falls through once its live read has settled
  // empty, so a loading row does not flash the thumbnail before the SVG.
  const liveSettledEmpty = !connected.isLoading && !showLive;
  const showSynced = hasSyncedAvatar && (!isConnectedRow || liveSettledEmpty);

  const hostQuery = useQuery<LegacyAvatarRead>({
    queryKey: chooserRowAvatarHostQueryKey(assistant.id),
    queryFn: ({ client }) => readRowAvatarViaHost(client, assistant.id),
    enabled:
      canReadRowAvatarViaHost(assistant) &&
      !hasSyncedAvatar &&
      (!isConnectedRow || liveSettledEmpty),
    staleTime: HOST_AVATAR_STALE_TIME_MS,
    // staleTime alone never refetches a chooser that stays mounted; the
    // disk read is cheap, so poll it while the window is in the foreground.
    refetchInterval: HOST_AVATAR_STALE_TIME_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const hostConclusive = hostQuery.isSuccess && hostQuery.data.conclusive;
  const showHost =
    !showLive &&
    hostQuery.data !== undefined &&
    (hostConclusive || !isEmptyAvatar(hostQuery.data));

  const platformAvatarUrls = usePlatformAvatarUrls();
  const canLookUp = canLookUpRowAvatarByPlatformId(assistant);
  const lookupId = usePlatformLookupId(assistant, canLookUp);
  const lookupCandidate =
    canLookUp && lookupId !== null
      ? (platformAvatarUrls.get(lookupId) ?? null)
      : null;
  const lookupUrl =
    lookupCandidate !== failedPlatformUrl ? lookupCandidate : null;
  // Waits out an in-flight host read so a row never flashes the thumbnail
  // before the disk snapshot replaces it.
  const showLookup =
    lookupUrl !== null &&
    !showLive &&
    !showSynced &&
    !showHost &&
    !hostQuery.isLoading &&
    (!isConnectedRow || liveSettledEmpty);

  const cacheQuery = useQuery<AvatarRead>({
    queryKey: chooserRowAvatarCacheQueryKey(assistant.id),
    queryFn: () => readCachedRowAvatar(assistant.id),
    enabled: !showLive && !hasSyncedAvatar && !showHost && !showLookup,
    staleTime: Infinity,
    structuralSharing: false,
    retry: false,
  });

  const onImageError = useCallback(() => {
    if (showSynced) {
      setFailedPlatformUrl(syncedUrl);
    } else if (showLookup) {
      setFailedPlatformUrl(lookupUrl);
    }
  }, [showSynced, syncedUrl, showLookup, lookupUrl]);

  const avatar: AvatarRead = showLive
    ? (live ?? EMPTY_AVATAR)
    : showSynced
      ? (syncedAvatar ?? EMPTY_AVATAR)
      : showHost
        ? { traits: hostQuery.data.traits, imageUrl: hostQuery.data.imageUrl }
        : showLookup
          ? { traits: null, imageUrl: lookupUrl }
          : (cacheQuery.data ?? EMPTY_AVATAR);
  return { ...avatar, onImageError };
}
