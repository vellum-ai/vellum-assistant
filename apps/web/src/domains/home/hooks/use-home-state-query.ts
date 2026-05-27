import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchRelationshipState } from "../api";
import type { RelationshipState } from "../types";

const QUERY_KEY_PREFIX = "home-state" as const;

function homeStateQueryKey(assistantId: string) {
  return [QUERY_KEY_PREFIX, assistantId] as const;
}

/**
 * React Query hook for the assistant relationship state (tier, facts,
 * capabilities, conversation count, etc.).
 */
export function useHomeStateQuery(assistantId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<RelationshipState>({
    queryKey: homeStateQueryKey(assistantId ?? ""),
    queryFn: () => fetchRelationshipState(assistantId!),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({
      queryKey: homeStateQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  return {
    ...query,
    invalidate,
  };
}
