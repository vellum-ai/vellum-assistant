import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrlResult,
  fetchCharacterTraitsResult,
} from "@/assistant/avatar-api";
import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { useSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";

export const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

export function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

/** The shape cached under {@link avatarQueryKey}; read directly by cache consumers. */
export interface AvatarData {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

const activeBlobUrls = new Map<string, string>();

export interface AssistantAvatarOptions {
  /**
   * Per-assistant override for the avatar-state-manifest capability. The
   * default gate reads the ACTIVE assistant's version, which is wrong for
   * a sibling assistant on another runtime: a pre-manifest sibling would
   * be asked for `/avatar/state` it doesn't serve and its avatar would
   * collapse to the fallback. List surfaces resolve the sibling's own
   * version (`versionSupportsAvatarStateManifest`) and pass it here;
   * `undefined` keeps the active-assistant gate.
   */
  supportsManifest?: boolean;
  /**
   * Skip the fetch entirely (`false`) and hand consumers the null avatar.
   * For sibling assistants whose transport cannot be addressed
   * independently: with a self-hosted ingress active, every daemon request
   * is rewritten to that single gateway whatever assistant id the path
   * carries, so a sibling fetch would return the ACTIVE assistant's
   * avatar. Defaults to `true`.
   */
  enabled?: boolean;
}

export interface AvatarRead {
  traits: CharacterTraits | null;
  imageUrl: string | null;
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
 * Resolve the avatar render mode from the authoritative `/avatar/state`
 * manifest (assistants on `MIN_VERSION`+). Throws on a null state so React
 * Query keeps the previously cached avatar instead of blanking out — see
 * the `retry` / `staleTime` options below.
 */
export async function fetchAvatarViaManifest(
  assistantId: string,
): Promise<AvatarRead> {
  const state = await fetchAvatarState(assistantId);
  if (state === null) {
    // `fetchAvatarState` returns null only on transport failure. Throw
    // rather than resolve to an empty avatar: React Query keeps the
    // previously cached avatar data on error (it does not overwrite
    // `data`) and retries, so with `staleTime: Infinity` consumers keep
    // showing the last good avatar instead of blanking out to the "V".
    throw new Error("Failed to fetch avatar state");
  }
  return resolveAvatarFromState(assistantId, state);
}

/**
 * A legacy sidecar read plus whether it is authoritative: a found file is;
 * two 404s are a real bare avatar; any transport failure is inconclusive.
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

/** {@link readAvatarViaLegacyFiles} that throws on an inconclusive read, like the manifest path. */
export async function fetchAvatarViaLegacyFiles(
  assistantId: string,
): Promise<AvatarRead> {
  const { traits, imageUrl, conclusive } =
    await readAvatarViaLegacyFiles(assistantId);
  if (!conclusive) {
    throw new Error("Failed to fetch avatar sidecars");
  }
  return { traits, imageUrl };
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
    queryFn: async () => {
      const id = assistantId!;
      const [components, { traits, imageUrl }] = await Promise.all([
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

      const prev = activeBlobUrls.get(id);
      if (prev && prev !== imageUrl) {
        URL.revokeObjectURL(prev);
      }
      if (imageUrl) {
        activeBlobUrls.set(id, imageUrl);
      } else {
        activeBlobUrls.delete(id);
      }

      return { components, traits, customImageUrl: imageUrl };
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
    isLoading,
    isSuccess,
    supportsManifest,
    invalidate,
  };
}
