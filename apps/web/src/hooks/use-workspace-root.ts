/**
 * Resolve the assistant's absolute workspace root directory. The root is stable
 * for the lifetime of an assistant, so it is cached indefinitely and shared
 * across consumers (e.g. chat path-linkification) via a single query.
 */

import { useQuery } from "@tanstack/react-query";

import { workspaceTreeGet } from "@/generated/daemon/sdk.gen";

export function useWorkspaceRoot(
  assistantId: string | null,
): string | undefined {
  const { data } = useQuery({
    queryKey: ["workspace-root", assistantId],
    enabled: !!assistantId,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const { data, error } = await workspaceTreeGet({
        path: { assistant_id: assistantId! },
        query: {},
      });
      if (error) throw error;
      return data?.root ?? null;
    },
  });
  return data ?? undefined;
}
