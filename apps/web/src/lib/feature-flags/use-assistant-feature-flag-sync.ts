import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import {
  ASSISTANT_FLAG_DEFAULTS,
  type AssistantFeatureFlags,
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

const ASSISTANT_DEFAULTS = ASSISTANT_FLAG_DEFAULTS;

const NORMALIZED_TO_STORE_KEY: Record<string, keyof AssistantFeatureFlags> = {};
for (const key of Object.keys(ASSISTANT_DEFAULTS) as (keyof AssistantFeatureFlags)[]) {
  NORMALIZED_TO_STORE_KEY[key.toLowerCase()] = key;
}

function gatewayKeyToStoreKey(
  gatewayKey: string,
): keyof AssistantFeatureFlags | undefined {
  return NORMALIZED_TO_STORE_KEY[gatewayKey.replace(/-/g, "").toLowerCase()];
}

function mapFlags(
  entries: FeatureFlagEntry[],
): Partial<AssistantFeatureFlags> {
  const mapped: Partial<AssistantFeatureFlags> = {};
  for (const entry of entries) {
    const storeKey = gatewayKeyToStoreKey(entry.key);
    if (storeKey) {
      Object.assign(mapped, { [storeKey]: entry.enabled });
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

export function useAssistantFeatureFlagSync(assistantId: string | null) {
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
      useAssistantFeatureFlagStore.getState().setFlags(mapFlags(data.flags));
    }
  }, [data]);
}
