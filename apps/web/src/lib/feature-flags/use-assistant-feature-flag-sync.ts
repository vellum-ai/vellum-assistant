import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useAssistantFeatureFlagStore, setAssistantIdForFlags } from "@/lib/feature-flags/assistant-feature-flag-store.js";
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

export function useAssistantFeatureFlagSync(assistantId: string | null) {
  const enabled = assistantId !== null;
  const prevAssistantId = useRef(assistantId);

  useEffect(() => {
    if (prevAssistantId.current !== assistantId) {
      useAssistantFeatureFlagStore.getState().setFlags(ASSISTANT_FLAG_DEFAULTS);
      prevAssistantId.current = assistantId;
    }
    setAssistantIdForFlags(assistantId);
  }, [assistantId]);

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
