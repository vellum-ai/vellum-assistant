import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrl,
  fetchCharacterTraits,
} from "@/assistant/avatar-api";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { useSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { avatarQueryKey } from "@/lib/sync/query-tags";

interface AvatarData {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

const activeBlobUrls = new Map<string, string>();

/**
 * Resolve the avatar render mode from the authoritative `/avatar/state`
 * manifest (assistants on `MIN_VERSION`+). Throws on a null state so React
 * Query keeps the previously cached avatar instead of blanking out — see
 * the `retry` / `staleTime` options below.
 */
async function fetchAvatarViaManifest(
  assistantId: string,
): Promise<{ traits: CharacterTraits | null; imageUrl: string | null }> {
  const state = await fetchAvatarState(assistantId);
  if (state === null) {
    // `fetchAvatarState` returns null only on transport failure. Throw
    // rather than resolve to an empty avatar: React Query keeps the
    // previously cached avatar data on error (it does not overwrite
    // `data`) and retries, so with `staleTime: Infinity` consumers keep
    // showing the last good avatar instead of blanking out to the "V".
    throw new Error("Failed to fetch avatar state");
  }

  if (state.kind === "character") {
    // Built/AI character: render the animated SVG from traits. The daemon
    // also writes a derived avatar-image.png raster, but the web never
    // uses it, so we skip the image fetch entirely.
    return { traits: state.traits, imageUrl: null };
  }
  if (state.kind === "image") {
    // Custom uploaded image: render the static circle.
    return { traits: null, imageUrl: await fetchAvatarImageUrl(assistantId) };
  }
  // kind === "none": both stay null, and ChatAvatar falls back to default
  // components / the "V".
  return { traits: null, imageUrl: null };
}

/**
 * Pre-manifest render-mode inference for assistants without `/avatar/state`:
 * a custom image exists ⇒ render it; otherwise read the character-traits
 * sidecar. Mirrors the daemon's legacy file-precedence ordering and is kept
 * alive behind the version gate — see
 * `lib/backwards-compat/avatar-state-manifest.ts`.
 */
async function fetchAvatarViaLegacyFiles(
  assistantId: string,
): Promise<{ traits: CharacterTraits | null; imageUrl: string | null }> {
  const imageUrl = await fetchAvatarImageUrl(assistantId);
  // Skip the traits fetch when a custom image exists — the traits file is
  // intentionally deleted on the daemon side in that case, so requesting it
  // just generates 404s. `AvatarRenderer` only reads `traits` when there is
  // no `customImageUrl`.
  const traits = imageUrl ? null : await fetchCharacterTraits(assistantId);
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
export function useAssistantAvatar(assistantId: string | null) {
  const queryClient = useQueryClient();
  const supportsManifest = useSupportsAvatarStateManifest();

  const { data, isLoading } = useQuery<AvatarData>({
    queryKey: [...avatarQueryKey(assistantId ?? ""), supportsManifest],
    queryFn: async () => {
      const id = assistantId!;
      const [components, { traits, imageUrl }] = await Promise.all([
        fetchCharacterComponents(id),
        supportsManifest
          ? fetchAvatarViaManifest(id)
          : fetchAvatarViaLegacyFiles(id),
      ]);

      // Character components are a static catalog that must always be
      // available from a running daemon. A null result indicates a transient
      // transport failure — throw so React Query retries instead of caching
      // a partial result that leaves the avatar stuck on the "V" fallback.
      if (!components) {
        if (imageUrl) {
          URL.revokeObjectURL(imageUrl);
        }
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
    enabled: Boolean(assistantId),
    staleTime: Infinity,
    structuralSharing: false,
    // Retry transient failures (character-components or avatar-state) once
    // so a flaky fetch or a briefly-unavailable daemon recovers without a
    // manual invalidate.
    retry: 1,
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  return {
    components: data?.components ?? null,
    traits: data?.traits ?? null,
    customImageUrl: data?.customImageUrl ?? null,
    isLoading,
    invalidate,
  };
}
