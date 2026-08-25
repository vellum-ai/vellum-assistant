import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAvatarViaLegacyFiles,
  fetchAvatarViaManifest,
  useAssistantAvatar,
} from "@/hooks/use-assistant-avatar";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import {
  deleteLastSeenAvatar,
  readLastSeenAvatar,
  writeLastSeenAvatar,
} from "@/lib/avatar-last-seen-cache";
import { versionSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import {
  type ResolvedAssistant,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";

export const CHOOSER_ROW_AVATAR_QUERY_KEY_PREFIX = "chooserRowAvatar";
export const CHOOSER_ROW_AVATAR_CACHE_QUERY_KEY_PREFIX =
  "chooserRowAvatarCache";

export type RowManifestSupport = "supported" | "unsupported" | "unknown";

/**
 * Tri-state manifest gate for a row's own runtime. Part of the query key so
 * a version change after an upgrade re-runs the fetch through the other path.
 */
export function rowManifestSupport(
  assistant: ResolvedAssistant,
): RowManifestSupport {
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
  return [CHOOSER_ROW_AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

export function chooserRowAvatarQueryKey(
  assistantId: string,
  manifestSupport: RowManifestSupport,
) {
  return [
    ...chooserRowAvatarQueryKeyPrefix(assistantId),
    manifestSupport,
  ] as const;
}

export function chooserRowAvatarCacheQueryKey(assistantId: string) {
  return [CHOOSER_ROW_AVATAR_CACHE_QUERY_KEY_PREFIX, assistantId] as const;
}

export interface ChooserRowAvatar {
  traits: CharacterTraits | null;
  imageUrl: string | null;
}

const EMPTY_AVATAR: ChooserRowAvatar = { traits: null, imageUrl: null };

/**
 * The legacy sidecar path swallows read failures into nulls, so an empty
 * result may be a transient error rather than a bare avatar. Let it go stale
 * on a normal clock instead of pinning the glyph fallback forever.
 */
export const EMPTY_AVATAR_STALE_TIME_MS = 60_000;

/** Separate from `use-assistant-avatar`'s map so the two caches never revoke each other's URLs. */
const activeBlobUrls = new Map<string, string>();

/** Object URLs minted from cached Blobs; kept apart so a live fetch never revokes a cached URL. */
const cachedBlobUrls = new Map<string, string>();

/** Latest fetch generation per row; a superseded fetch must not touch the map. */
const fetchGenerations = new Map<string, number>();

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
 * Manifest reads for runtimes known to serve `/avatar/state`; legacy sidecar
 * reads for runtimes known not to. An unknown version probes the manifest
 * first and falls back to the sidecars when the probe fails.
 */
async function fetchRowAvatar(
  assistant: ResolvedAssistant,
  manifestSupport: RowManifestSupport,
): Promise<ChooserRowAvatar> {
  if (manifestSupport === "supported") {
    return fetchAvatarViaManifest(assistant.id);
  }
  if (manifestSupport === "unknown") {
    try {
      return await fetchAvatarViaManifest(assistant.id);
    } catch {
      // Probe failed: the runtime is likely pre-manifest.
    }
  }
  return fetchAvatarViaLegacyFiles(assistant.id);
}

function trackBlobUrl(
  urls: Map<string, string>,
  assistantId: string,
  imageUrl: string | null,
): void {
  const prev = urls.get(assistantId);
  if (prev && prev !== imageUrl) {
    URL.revokeObjectURL(prev);
  }
  if (imageUrl) {
    urls.set(assistantId, imageUrl);
  } else {
    urls.delete(assistantId);
  }
}

/**
 * Runs one fetch generation for `assistant`. A re-key (manifest support
 * flipping) can start a newer fetch while this one is in flight; when the
 * older one finishes last it must not revoke the URL the newer query renders,
 * so it drops its own blob instead.
 */
async function fetchRowAvatarGeneration(
  assistant: ResolvedAssistant,
  manifestSupport: RowManifestSupport,
): Promise<ChooserRowAvatar> {
  const generation = (fetchGenerations.get(assistant.id) ?? 0) + 1;
  fetchGenerations.set(assistant.id, generation);
  const avatar = await fetchRowAvatar(assistant, manifestSupport);
  if (fetchGenerations.get(assistant.id) !== generation) {
    if (avatar.imageUrl) {
      URL.revokeObjectURL(avatar.imageUrl);
    }
    return { traits: avatar.traits, imageUrl: null };
  }
  trackBlobUrl(activeBlobUrls, assistant.id, avatar.imageUrl);
  return avatar;
}

function isEmptyAvatar(avatar: ChooserRowAvatar | undefined): boolean {
  return avatar !== undefined && !avatar.traits && !avatar.imageUrl;
}

// Last-seen cache (IndexedDB). Only LIVE sources feed it: the connected
// row's `useAssistantAvatar` and the platform-proxy per-row fetch. Durable
// sources (host disk, platform URLs) must never be written back here.

async function persistLastSeenAvatar(
  assistantId: string,
  avatar: ChooserRowAvatar,
): Promise<void> {
  if (avatar.imageUrl) {
    const blob = await fetch(avatar.imageUrl).then((r) => r.blob());
    await writeLastSeenAvatar(assistantId, { kind: "image", blob });
  } else if (avatar.traits) {
    await writeLastSeenAvatar(assistantId, {
      kind: "character",
      traits: avatar.traits,
    });
  } else {
    await deleteLastSeenAvatar(assistantId);
  }
}

async function readCachedRowAvatar(
  assistantId: string,
): Promise<ChooserRowAvatar> {
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
 * 2. Other platform rows fetch per id through the platform proxy, only when
 *    {@link canFetchRowAvatarViaPlatformProxy} says the id is honored and the
 *    org store can supply the `Vellum-Organization-Id` header.
 * 3. The last-seen cache: whatever a live source last resolved for this id,
 *    so a row keeps its avatar while the assistant is unreachable.
 * Anything else, including every failure, resolves to nulls: the row's glyph
 * fallback is the error state, a chooser row never surfaces an error.
 */
export function useChooserRowAvatar(
  assistant: ResolvedAssistant,
): ChooserRowAvatar {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isConnectedRow = assistant.id === activeAssistantId;
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();

  const connected = useAssistantAvatar(isConnectedRow ? assistant.id : null);

  const manifestSupport = rowManifestSupport(assistant);
  const rowQuery = useQuery<ChooserRowAvatar>({
    queryKey: chooserRowAvatarQueryKey(assistant.id, manifestSupport),
    queryFn: () => fetchRowAvatarGeneration(assistant, manifestSupport),
    enabled:
      !isConnectedRow &&
      isOrgReady &&
      canFetchRowAvatarViaPlatformProxy(assistant),
    staleTime: (query) =>
      isEmptyAvatar(query.state.data) ? EMPTY_AVATAR_STALE_TIME_MS : Infinity,
    structuralSharing: false,
    // A rejected query leaves `data` undefined, which reads as nulls below.
    retry: 1,
  });

  // A live source is "settled" once its query succeeded; on error React
  // Query keeps prior data, which is still worth rendering but not caching.
  const live: ChooserRowAvatar | undefined = isConnectedRow
    ? { traits: connected.traits, imageUrl: connected.customImageUrl }
    : rowQuery.data;
  const liveSettled = isConnectedRow ? connected.isSuccess : rowQuery.isSuccess;
  const showLive = liveSettled || (live !== undefined && !isEmptyAvatar(live));

  const liveTraits = live?.traits ?? null;
  const liveImageUrl = live?.imageUrl ?? null;
  useEffect(() => {
    if (!liveSettled) {
      return;
    }
    const assistantId = assistant.id;
    void persistLastSeenAvatar(assistantId, {
      traits: liveTraits,
      imageUrl: liveImageUrl,
    })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: chooserRowAvatarCacheQueryKey(assistantId),
        }),
      )
      .catch(() => {});
  }, [assistant.id, liveSettled, liveTraits, liveImageUrl, queryClient]);

  const cacheQuery = useQuery<ChooserRowAvatar>({
    queryKey: chooserRowAvatarCacheQueryKey(assistant.id),
    queryFn: () => readCachedRowAvatar(assistant.id),
    enabled: !showLive,
    staleTime: Infinity,
    structuralSharing: false,
    retry: false,
  });

  if (showLive) {
    return live ?? EMPTY_AVATAR;
  }
  return cacheQuery.data ?? EMPTY_AVATAR;
}
