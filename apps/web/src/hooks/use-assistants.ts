import { useQuery } from "@tanstack/react-query";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { isLocalMode, isLocalAssistant } from "@/lib/local-mode";
import { useLockfileStore } from "@/stores/lockfile-store";

export interface AssistantEntry {
  id: string;
  name?: string;
  isLocal: boolean;
}

export interface UseAssistantsResult {
  assistants: AssistantEntry[];
  isLoading: boolean;
}

export function useAssistants(): UseAssistantsResult {
  const lockfile = useLockfileStore.use.lockfile();
  const local = isLocalMode();

  const apiQuery = useQuery({
    ...assistantsListOptions(),
    enabled: !local,
  });

  if (local) {
    if (lockfile == null) {
      return { assistants: [], isLoading: true };
    }
    return {
      assistants: lockfile.assistants.map((a) => ({
        id: a.assistantId,
        name: a.name,
        isLocal: isLocalAssistant(a),
      })),
      isLoading: false,
    };
  }

  return {
    assistants: (apiQuery.data?.results ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      isLocal: a.is_local,
    })),
    isLoading: apiQuery.isPending,
  };
}
