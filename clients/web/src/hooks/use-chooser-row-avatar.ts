import { useQuery } from "@tanstack/react-query";

import {
  fetchAvatarViaLegacyFiles,
  fetchAvatarViaManifest,
  useAssistantAvatar,
} from "@/hooks/use-assistant-avatar";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isGatewayAuthEnabled } from "@/lib/auth/gateway-session";
import { versionSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import {
  type ResolvedAssistant,
  useResolvedAssistantsStore,
} from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";

export const CHOOSER_ROW_AVATAR_QUERY_KEY_PREFIX = "chooserRowAvatar";

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

function trackBlobUrl(assistantId: string, imageUrl: string | null): void {
  const prev = activeBlobUrls.get(assistantId);
  if (prev && prev !== imageUrl) {
    URL.revokeObjectURL(prev);
  }
  if (imageUrl) {
    activeBlobUrls.set(assistantId, imageUrl);
  } else {
    activeBlobUrls.delete(assistantId);
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
  trackBlobUrl(assistant.id, avatar.imageUrl);
  return avatar;
}

function isEmptyAvatar(avatar: ChooserRowAvatar | undefined): boolean {
  return avatar !== undefined && !avatar.traits && !avatar.imageUrl;
}

/**
 * Avatar data for one chooser row, resolved through a precedence chain:
 * 1. The connected row reuses `useAssistantAvatar`'s cache, correct in every
 *    transport mode and never fetched twice.
 * 2. Other platform rows fetch per id through the platform proxy, only when
 *    {@link canFetchRowAvatarViaPlatformProxy} says the id is honored and the
 *    org store can supply the `Vellum-Organization-Id` header.
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

  const manifestSupport = rowManifestSupport(assistant);
  const { data } = useQuery<ChooserRowAvatar>({
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

  if (isConnectedRow) {
    return { traits: connected.traits, imageUrl: connected.customImageUrl };
  }
  return data ?? EMPTY_AVATAR;
}
