
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCharacterComponents,
  fetchCharacterTraits,
  fetchAvatarImageUrl,
} from "@/lib/avatar/api.js";
import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";

interface AvatarData {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}

// Module-scoped map tracking the active blob URL per assistant so it can be
// revoked when a new fetch replaces it. Keyed by assistantId, not by hook
// instance, so multiple consumers sharing the same query never double-revoke.
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
      const [components, traits, imageUrl] = await Promise.all([
        fetchCharacterComponents(id),
        fetchCharacterTraits(id),
        fetchAvatarImageUrl(id),
      ]);

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
