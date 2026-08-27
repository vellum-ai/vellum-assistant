import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrlResult,
  fetchCharacterTraitsResult,
} from "@/assistant/avatar-api";
import { useSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { trackBlobUrl } from "@/lib/blob-url-tracker";
import { createGenerationGuard } from "@/lib/generation-guard";
import { persistLastSeenAvatar } from "@/lib/persist-last-seen-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type {
  AvatarRead,
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";

export const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

export function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

/** The shape cached under {@link avatarQueryKey}; read directly by cache consumers. */
export interface AvatarData {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  /**
   * The render manifest the three fields above were derived from. Consumers
   * that need `kind` rather than just traits read it from here so they stay on
   * this one query, because a second query would miss the `avatar_updated`
   * sweep that keeps this one live.
   *
   * Optional because surfaces that seed this cache by hand (the takeover
   * avatar stash, stories) carry only what they paint with. A missing state
   * reads as unknown, which every consumer must treat as "not a character".
   */
  state?: AvatarState | null;
}

const activeBlobUrls = new Map<string, string>();

/** Latest fetch generation per assistant; a superseded fetch must not persist or track. */
const fetchGenerations = createGenerationGuard();

/**
 * Revoke the object URL this hook holds for a removed assistant, and
 * supersede any in-flight fetch so it drops its own blob instead.
 */
export function releaseAssistantAvatarUrl(assistantId: string): void {
  fetchGenerations.invalidate(assistantId);
  trackBlobUrl(activeBlobUrls, assistantId, null);
}

export interface AssistantAvatarOptions {
  /**
   * Per-assistant manifest gate. The default reads the ACTIVE assistant's
   * version, which is wrong for a sibling on another runtime; list surfaces
   * resolve the sibling's own version and pass it here.
   */
  supportsManifest?: boolean;
  /**
   * `false` skips the fetch and hands consumers the null avatar, for siblings
   * whose transport cannot be addressed by id (see
   * `canFetchRowAvatarViaPlatformProxy` in `use-chooser-row-avatar`).
   */
  enabled?: boolean;
}

/**
 * Resolve the render mode from an already-fetched `/avatar/state` manifest.
 * Throws when the manifest promises an image whose content request fails,
 * so React Query keeps the previously cached avatar instead of blanking out.
 */
export async function resolveAvatarFromState(
  assistantId: string,
  state: AvatarState,
): Promise<AvatarRead> {
  if (state.kind === "character") {
    // Built/AI character: render the animated SVG from traits. The daemon
    // also writes a derived avatar-image.png raster, but the web never
    // uses it, so we skip the image fetch entirely.
    return { traits: state.traits, imageUrl: null };
  }
  if (state.kind === "image") {
    // Custom uploaded image: render the static circle. A 404 here means
    // the image went away after the manifest was read; that is a real none.
    const image = await fetchAvatarImageUrlResult(assistantId);
    if (image.status === "failed") {
      throw new Error("Failed to fetch avatar image");
    }
    return {
      traits: null,
      imageUrl: image.status === "found" ? image.value : null,
    };
  }
  // kind === "none": both stay null, and ChatAvatar falls back to default
  // components / the "V".
  return { traits: null, imageUrl: null };
}

/**
 * A read plus the manifest it was resolved from, so a consumer that needs
 * `kind` rather than just traits reads both off this one query.
 */
export interface AvatarReadWithState extends AvatarRead {
  state: AvatarState;
}

/**
 * Resolve the avatar render mode from the authoritative `/avatar/state`
 * manifest (assistants on `MIN_VERSION`+). Throws on a null state so React
 * Query keeps the previously cached avatar instead of blanking out — see
 * the `retry` / `staleTime` options below.
 */
export async function fetchAvatarViaManifest(
  assistantId: string,
): Promise<AvatarReadWithState> {
  const state = await fetchAvatarState(assistantId);
  if (state === null) {
    // `fetchAvatarState` returns null only on transport failure. Throw
    // rather than resolve to an empty avatar: React Query keeps the
    // previously cached avatar data on error (it does not overwrite
    // `data`) and retries, so with `staleTime: Infinity` consumers keep
    // showing the last good avatar instead of blanking out to the "V".
    throw new Error("Failed to fetch avatar state");
  }
  return { ...(await resolveAvatarFromState(assistantId, state)), state };
}

/**
 * A read plus whether it is authoritative. A found file or manifest answer
 * is; two sidecar 404s are a real bare avatar; a transport failure is not.
 */
export interface LegacyAvatarRead extends AvatarRead {
  conclusive: boolean;
}

/**
 * Pre-manifest render-mode inference for assistants without `/avatar/state`:
 * a custom image exists ⇒ render it; otherwise read the character-traits
 * sidecar. Mirrors the daemon's legacy file-precedence ordering and is kept
 * alive behind the version gate — see
 * `lib/backwards-compat/avatar-state-manifest.ts`.
 */
export async function readAvatarViaLegacyFiles(
  assistantId: string,
): Promise<LegacyAvatarRead> {
  const image = await fetchAvatarImageUrlResult(assistantId);
  // Skip the traits fetch when a custom image exists — the traits file is
  // intentionally deleted on the daemon side in that case, so requesting it
  // just generates 404s. `AvatarRenderer` only reads `traits` when there is
  // no `customImageUrl`.
  if (image.status === "found") {
    return { traits: null, imageUrl: image.value, conclusive: true };
  }
  if (image.status === "failed") {
    // The image outranks traits, so an unread image leaves the outcome unknown.
    return { traits: null, imageUrl: null, conclusive: false };
  }
  const traits = await fetchCharacterTraitsResult(assistantId);
  if (traits.status === "found") {
    return { traits: traits.value, imageUrl: null, conclusive: true };
  }
  return {
    traits: null,
    imageUrl: null,
    conclusive: traits.status === "absent",
  };
}

/**
 * The legacy file precedence restated as a manifest, so `state` has one shape
 * on both paths. `source` and `image` stay null because the sidecar files
 * carry neither.
 */
function legacyAvatarState(
  traits: CharacterTraits | null,
  imageUrl: string | null,
): AvatarState {
  if (imageUrl) {
    return { kind: "image", traits: null, source: null, image: null };
  }
  if (traits) {
    return { kind: "character", traits, source: null, image: null };
  }
  return { kind: "none", traits: null, source: null, image: null };
}

/** {@link readAvatarViaLegacyFiles} that throws on an inconclusive read, like the manifest path. */
export async function fetchAvatarViaLegacyFiles(
  assistantId: string,
): Promise<AvatarReadWithState> {
  const { traits, imageUrl, conclusive } =
    await readAvatarViaLegacyFiles(assistantId);
  if (!conclusive) {
    throw new Error("Failed to fetch avatar sidecars");
  }
  return { traits, imageUrl, state: legacyAvatarState(traits, imageUrl) };
}

/**
 * Shared hook for assistant avatar data backed by React Query.
 *
 * All consumers of the same `assistantId` share a single cached result.
 * Call `invalidate()` to trigger a refetch that every consumer sees.
 *
 * The render mode comes from the authoritative `/avatar/state` manifest on
 * assistants that expose it; older assistants fall back to inferring it from
 * the workspace sidecar files. The manifest-support flag is part of the query
 * key so the avatar re-fetches through the correct path the moment the
 * assistant version resolves.
 */
export function useAssistantAvatar(
  assistantId: string | null,
  options?: AssistantAvatarOptions,
) {
  const queryClient = useQueryClient();
  const activeSupportsManifest = useSupportsAvatarStateManifest();
  const supportsManifest = options?.supportsManifest ?? activeSupportsManifest;

  const { data, isLoading, isSuccess } = useQuery<AvatarData>({
    queryKey: [...avatarQueryKey(assistantId ?? ""), supportsManifest],
    queryFn: async ({ client }) => {
      const id = assistantId!;
      // A re-key (manifest support flipping) starts a newer fetch while this
      // one is in flight and does not abort it; when the older one finishes
      // last it must neither overwrite the last-seen entry nor revoke the
      // URL the newer query renders, so it drops its own blob instead.
      const generation = fetchGenerations.claim(id);
      // Decided at request time: the transport is pinned to whichever
      // assistant is active when the request goes out, so a read that was
      // issued for the active assistant is its avatar even if the user has
      // switched away by the time it lands (a reconnect sweep, say).
      const isActiveRead =
        id === useResolvedAssistantsStore.getState().activeAssistantId;
      const [components, { state, traits, imageUrl }] = await Promise.all([
        fetchCharacterComponents(id),
        supportsManifest
          ? fetchAvatarViaManifest(id)
          : fetchAvatarViaLegacyFiles(id),
      ]);

      // Character components are needed for the animated SVG avatar but NOT
      // for custom uploaded images — ChatAvatar renders those via a plain
      // <img> tag. Only treat null components as a failure when there is no
      // image to fall back on; otherwise the partial result is usable.
      if (!components && !imageUrl) {
        throw new Error("Failed to fetch character components");
      }

      if (!fetchGenerations.isCurrent(id, generation)) {
        if (imageUrl) {
          URL.revokeObjectURL(imageUrl);
        }
        return { components, traits, customImageUrl: null, state };
      }

      trackBlobUrl(activeBlobUrls, id, imageUrl);
      // A resolved read is conclusive (both paths throw otherwise), so it is
      // what the chooser falls back to once this assistant is unreachable.
      // Only the active assistant's read is trusted here: a sibling behind a
      // transport that ignores the id would cache the wrong avatar.
      if (isActiveRead) {
        void persistLastSeenAvatar(client, id, { traits, imageUrl });
      }

      return { components, traits, customImageUrl: imageUrl, state };
    },
    enabled: Boolean(assistantId) && (options?.enabled ?? true),
    staleTime: Infinity,
    structuralSharing: false,
    // Retry transient failures (character-components or avatar-state) once
    // so a flaky fetch or a briefly-unavailable daemon recovers without a
    // manual invalidate.
    retry: 1,
  });

  const invalidate = useCallback(() => {
    if (!assistantId) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  return {
    components: data?.components ?? null,
    traits: data?.traits ?? null,
    customImageUrl: data?.customImageUrl ?? null,
    state: data?.state ?? null,
    isLoading,
    isSuccess,
    invalidate,
  };
}
