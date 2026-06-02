import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  homeStateGetOptions,
  homeStateGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * React Query hook for the assistant relationship state (tier, facts,
 * capabilities, conversation count, etc.).
 */
export function useHomeStateQuery(assistantId: string | null) {
  const queryClient = useQueryClient();

  const stateQueryKey = useMemo(
    () =>
      homeStateGetQueryKey({
        path: { assistant_id: assistantId ?? "" },
      }),
    [assistantId],
  );

  const query = useQuery({
    ...homeStateGetOptions({
      path: { assistant_id: assistantId! },
    }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({ queryKey: stateQueryKey });
  }, [assistantId, queryClient, stateQueryKey]);

  return {
    ...query,
    invalidate,
  };
}
