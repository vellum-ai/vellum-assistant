import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrl,
} from "@/assistant/avatar-api";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { avatarQueryKey } from "@/lib/sync/query-tags";

interface AvatarData {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

const activeBlobUrls = new Map<string, string>();

/**
 * Shared hook for assistant avatar data backed by React Query.
 *
 * All consumers of the same `assistantId` share a single cached result.
 * Call `invalidate()` to trigger a refetch that every consumer sees.
 */
export function useAssistantAvatar(assistantId: string | null) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<AvatarData>({
    queryKey: avatarQueryKey(assistantId ?? ""),
    queryFn: async () => {
      const id = assistantId!;
      // The manifest `kind` is authoritative for rendering. Fetch it
      // alongside the SVG component set; only fetch the raster image
      // when the manifest says this assistant uses an uploaded image.
      const [components, state] = await Promise.all([
        fetchCharacterComponents(id),
        fetchAvatarState(id),
      ]);

      let traits: CharacterTraits | null = null;
      let imageUrl: string | null = null;

      if (state?.kind === "character") {
        // Built/AI character: render the animated SVG from traits. The
        // daemon also writes a derived avatar-image.png raster, but the
        // web never uses it, so we skip the image fetch entirely.
        traits = state.traits;
      } else if (state?.kind === "image") {
        // Custom uploaded image: render the static circle.
        imageUrl = await fetchAvatarImageUrl(id);
      }
      // kind === "none" (or null on transport failure): both stay null,
      // and ChatAvatar falls back to default components / the "V".

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
