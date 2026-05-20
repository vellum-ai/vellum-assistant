import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/generated/api/types.gen.js";
import { useOrganizationStore } from "@/stores/organization-store.js";

const PLATFORM_ASSISTANT_STORAGE_PREFIX = "vellum_current_assistant_id__";

const PLATFORM_LIST_OPTIONS = assistantsListOptions({
  query: { hosting: "platform" },
});

function storageKeyForOrg(orgId: string | null): string | null {
  if (!orgId) return null;
  return `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === null) {
      notify();
      return;
    }
    if (event.key.startsWith(PLATFORM_ASSISTANT_STORAGE_PREFIX)) {
      notify();
    }
  });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(orgId: string | null): string | null {
  const key = storageKeyForOrg(orgId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredId(orgId: string | null, id: string | null): void {
  const key = storageKeyForOrg(orgId);
  if (!key) return;
  try {
    if (id == null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, id);
    }
  } catch {
    // ignore storage failures
  }
  notify();
}

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

  const storedId = useSyncExternalStore(
    subscribe,
    useCallback(() => getSnapshot(orgId), [orgId]),
    () => null,
  );

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
    if (resolvedId != null) {
      writeStoredId(orgId, resolvedId);
    }
  }, [isListLoaded, platformAssistants.length, resolvedId, storedId, orgId]);

  const setAssistantId = useCallback(
    (id: string | null) => {
      writeStoredId(orgId, id);
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
