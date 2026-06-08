import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useOrganizationStore } from "@/stores/organization-store";

const PLATFORM_LIST_OPTIONS = assistantsListOptions({
  query: { hosting: "platform" },
});

export interface UseCurrentPlatformAssistantResult {
  assistantId: string | null;
  assistant: Assistant | null;
  setAssistantId: (id: string | null) => void;
  isLoading: boolean;
  isListLoaded: boolean;
  platformAssistants: Assistant[];
}

/**
 * Resolves and manages the active platform-hosted assistant for the
 * current organization. Fetches the platform assistant list, persists
 * the user's selection per-org, and auto-selects the first assistant
 * when no prior selection exists.
 */
export function useCurrentPlatformAssistant(): UseCurrentPlatformAssistantResult {
  const orgId = useOrganizationStore.use.currentOrganizationId();
  const byOrg =
    useResolvedAssistantsStore.use.selectedPlatformAssistantByOrg();

  const storedId = orgId ? (byOrg[orgId] ?? null) : null;

  const listQuery = useQuery(PLATFORM_LIST_OPTIONS);

  const platformAssistants = (listQuery.data?.results ?? []) as Assistant[];
  const isListLoaded = !listQuery.isPending;

  let resolvedAssistant: Assistant | null = null;
  let resolvedId: string | null;
  if (platformAssistants.length === 0) {
    resolvedId = storedId;
  } else {
    if (storedId) {
      resolvedAssistant =
        platformAssistants.find((a) => a.id === storedId) ?? null;
    }
    if (!resolvedAssistant) {
      resolvedAssistant = platformAssistants[0]!;
    }
    resolvedId = resolvedAssistant.id;
  }

  useEffect(() => {
    if (!isListLoaded) return;
    if (platformAssistants.length === 0) return;
    if (resolvedId === storedId) return;
    if (resolvedId != null && orgId) {
      useResolvedAssistantsStore
        .getState()
        .setSelectedPlatformAssistant(orgId, resolvedId);
    }
  }, [isListLoaded, platformAssistants.length, resolvedId, storedId, orgId]);

  const setAssistantId = useCallback(
    (id: string | null) => {
      if (!orgId) return;
      useResolvedAssistantsStore
        .getState()
        .setSelectedPlatformAssistant(orgId, id);
    },
    [orgId],
  );

  return {
    assistantId: resolvedId,
    assistant: resolvedAssistant,
    setAssistantId,
    isLoading: listQuery.isPending,
    isListLoaded,
    platformAssistants,
  };
}
