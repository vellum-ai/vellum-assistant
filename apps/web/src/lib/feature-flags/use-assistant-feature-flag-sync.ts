import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import {
  ASSISTANT_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog.js";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness.js";

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

export const ASSISTANT_FLAG_VALUES_QUERY_KEY = "assistant-feature-flag-values" as const;

/**
 * Shared so the Developer panel can layer a same-key observer on the
 * exact same query and let TanStack Query dedupe the fetch.
 */
export function assistantFlagValuesQueryKey(assistantId: string | null) {
  return [ASSISTANT_FLAG_VALUES_QUERY_KEY, assistantId] as const;
}

function mapFlags(
  entries: FeatureFlagEntry[],
): Record<string, boolean> {
  const mapped: Record<string, boolean> = {};
  for (const entry of entries) {
    const storeKey = flagKeyToStoreKey(entry.key);
    if (VALID_KEYS.has(storeKey)) {
      mapped[storeKey] = entry.enabled;
    }
  }
  return mapped;
}

export async function fetchAssistantFlagValues(
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
 * Fetches `/v1/assistants/:id/feature-flags` once per assistant and
 * resets the store on assistant switch. Mount on `RootLayout`.
 */
export function useAssistantFeatureFlagSync(assistantId: string | null) {
  const enabled = assistantId !== null;
  const prevAssistantId = useRef(assistantId);

  useEffect(() => {
    if (prevAssistantId.current !== assistantId) {
      // Reset to registry defaults AND clear hasHydrated — until the next
      // /feature-flags response lands, callers must treat current values
      // as provisional. See `hasHydrated` doc on the store.
      useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
      prevAssistantId.current = assistantId;
    }
  }, [assistantId]);

  const freshness = useFlagQueryFreshness();
  const { data } = useQuery({
    queryKey: assistantFlagValuesQueryKey(assistantId),
    queryFn: () => fetchAssistantFlagValues(assistantId!),
    enabled,
    ...freshness,
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


