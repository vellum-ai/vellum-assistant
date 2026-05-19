
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";

interface ResolvedAssistantId {
  assistantId: string | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Resolve the assistant the Logs & Usage tabs should target.
 *
 * Mirrors the chat page: sort assistants by creation date ascending and
 * pick the oldest, so multi-assistant users see consistent data across
 * tabs. React Query dedupes the underlying request so all three tabs
 * share a single fetch.
 */
export function useResolvedAssistantId(): ResolvedAssistantId {
  const { data, isLoading, isError } = useQuery(assistantsListOptions());
  const assistantId = useMemo(() => {
    const assistants = data?.results ?? [];
    if (assistants.length === 0) {
      return undefined;
    }
    const sorted = [...assistants].sort(
      (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
    );
    return sorted[0]?.id;
  }, [data?.results]);

  return { assistantId, isLoading, isError };
}
