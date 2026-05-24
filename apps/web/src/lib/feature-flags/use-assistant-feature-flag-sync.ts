import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import {
  setAssistantIdForFlags,
  useAssistantFeatureFlagStore,
  useCurrentFlagAssistantId,
} from "@/lib/feature-flags/assistant-feature-flag-store.js";
import {
  ASSISTANT_FLAG_DEFAULTS,
  ldKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog.js";

interface FeatureFlagEntry {
  key: string;
  enabled: boolean;
  label: string;
  defaultEnabled: boolean;
  description: string;
}

interface AssistantFlagValuesResponse {
  flags: FeatureFlagEntry[];
}

const VALID_KEYS = new Set(Object.keys(ASSISTANT_FLAG_DEFAULTS));

function mapFlags(
  entries: FeatureFlagEntry[],
): Record<string, boolean> {
  const mapped: Record<string, boolean> = {};
  for (const entry of entries) {
    const storeKey = ldKeyToStoreKey(entry.key);
    if (VALID_KEYS.has(storeKey)) {
      mapped[storeKey] = entry.enabled;
    }
  }
  return mapped;
}

async function fetchAssistantFlagValues(
  assistantId: string,
): Promise<AssistantFlagValuesResponse> {
  const { data, error, response } = await client.get<
    AssistantFlagValuesResponse,
    Record<string, unknown>,
    false
  >({
    url: `/v1/assistants/${assistantId}/feature-flags`,
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to fetch assistant feature flags",
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch assistant feature flags: ${response.status}`,
    );
  }
  return data as AssistantFlagValuesResponse;
}

/**
 * Lightweight, app-wide effect that:
 *
 *   1. Pushes the current assistantId into the assistant-feature-flag
 *      store so {@link useAssistantFeatureFlagStore} `setFlag` overrides
 *      can PATCH the correct assistant.
 *   2. Resets the store to registry defaults whenever the active
 *      assistant switches, so flag values from the previous assistant
 *      don't leak across the boundary.
 *
 * Mount this on the app root. Polling the actual flag values is a
 * separate concern and lives in {@link useAssistantFeatureFlagPolling}
 * (currently mounted only on the Developer → Feature Flags panel to
 * keep network noise off chat-bound SSE debugging).
 */
export function useAssistantFeatureFlagIdTracker(assistantId: string | null) {
  const prevAssistantId = useRef(assistantId);

  useEffect(() => {
    if (prevAssistantId.current !== assistantId) {
      // Reset to registry defaults AND clear hasHydrated — until the next
      // /feature-flags response lands, callers must treat current values
      // as provisional. See `hasHydrated` doc on the store.
      useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
      prevAssistantId.current = assistantId;
    }
    setAssistantIdForFlags(assistantId);
  }, [assistantId]);
}

/**
 * Polls `/v1/assistants/{id}/feature-flags` and pushes results into the
 * assistant feature flag store. Mount this only when the Developer tab
 * surfaces live flag values; the rest of the app reads the store
 * populated from registry defaults + localStorage overrides without
 * needing a live server signal.
 *
 * Reads the active assistantId from the same source the id-tracker
 * writes to, so a caller doesn't need to thread it through outlet
 * context. Pair with {@link useAssistantFeatureFlagIdTracker} on the
 * app root so assistant switches still reset the store and overrides
 * know which assistant they belong to.
 */
export function useAssistantFeatureFlagPolling() {
  const assistantId = useCurrentFlagAssistantId();
  const enabled = assistantId !== null;

  const { data } = useQuery({
    queryKey: ["assistant-feature-flag-values", assistantId] as const,
    queryFn: () => fetchAssistantFlagValues(assistantId!),
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      const store = useAssistantFeatureFlagStore.getState();
      store.setFlags(mapFlags(data.flags));
      // Mark hydrated AFTER values are written so a consumer subscribing
      // to both fields sees the real flag in the same render that
      // hasHydrated flips to true.
      store.markHydrated();
    }
  }, [data]);
}
