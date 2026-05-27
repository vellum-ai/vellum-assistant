import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchCharacterTraits,
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
      const [components, imageUrl] = await Promise.all([
        fetchCharacterComponents(id),
        fetchAvatarImageUrl(id),
      ]);
      // Skip the traits fetch when a custom image exists — the traits
      // file is intentionally deleted on the daemon side in that case,
      // so requesting it just generates 404s on every SSE-driven
      // reconnect invalidation. `AvatarRenderer` only reads `traits`
      // when there is no `customImageUrl`.
      const traits = imageUrl ? null : await fetchCharacterTraits(id);

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
