import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/generated/api/types.gen.js";
import { useCurrentPlatformAssistantStore } from "@/domains/settings/current-platform-assistant-store.js";
import { useOrganizationStore } from "@/stores/organization-store.js";

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

export function useCurrentPlatformAssistant(): UseCurrentPlatformAssistantResult {
  const orgId = useOrganizationStore.use.currentOrganizationId();
  const byOrg = useCurrentPlatformAssistantStore.use.byOrg();

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
      useCurrentPlatformAssistantStore
        .getState()
        .setAssistantId(orgId, resolvedId);
    }
  }, [isListLoaded, platformAssistants.length, resolvedId, storedId, orgId]);

  const setAssistantId = useCallback(
    (id: string | null) => {
      if (!orgId) return;
      useCurrentPlatformAssistantStore.getState().setAssistantId(orgId, id);
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
