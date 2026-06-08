import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  ASSISTANT_FLAG_DEFAULTS,
  ASSISTANT_STRING_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";
import { assistantFlagValuesQueryKey } from "@/lib/sync/query-tags";

interface FeatureFlagEntry {
  key: string;
  enabled: boolean | string;
  label: string;
  defaultEnabled: boolean | string;
  description: string;
}

interface AssistantFlagValuesResponse {
  flags: FeatureFlagEntry[];
}

const VALID_BOOL_KEYS = new Set(Object.keys(ASSISTANT_FLAG_DEFAULTS));
const VALID_STRING_KEYS = new Set(Object.keys(ASSISTANT_STRING_FLAG_DEFAULTS));

function mapFlags(
  entries: FeatureFlagEntry[],
): { boolFlags: Record<string, boolean>; stringFlags: Record<string, string> } {
  const boolFlags: Record<string, boolean> = {};
  const stringFlags: Record<string, string> = {};
  for (const entry of entries) {
    const storeKey = flagKeyToStoreKey(entry.key);
    if (typeof entry.enabled === "boolean" && VALID_BOOL_KEYS.has(storeKey)) {
      boolFlags[storeKey] = entry.enabled;
    } else if (typeof entry.enabled === "string" && VALID_STRING_KEYS.has(storeKey)) {
      stringFlags[storeKey] = entry.enabled;
    }
  }
  return { boolFlags, stringFlags };
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
      const { boolFlags, stringFlags } = mapFlags(data.flags);
      store.setFlags(boolFlags);
      if (Object.keys(stringFlags).length > 0) {
        store.setStringFlags(stringFlags);
      }
      // Mark hydrated AFTER values are written so a consumer subscribing
      // to both fields sees the real flag in the same render that
      // hasHydrated flips to true.
      store.markHydrated();
    }
  }, [data]);
}


