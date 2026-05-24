import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
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

const ASSISTANT_FLAG_VALUES_QUERY_KEY = "assistant-feature-flag-values" as const;

function flagValuesQueryKey(assistantId: string | null) {
  return [ASSISTANT_FLAG_VALUES_QUERY_KEY, assistantId] as const;
}

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
 * App-root sync hook: fetches `/v1/assistants/:id/feature-flags` once
 * per assistant, applies it to the store, marks `hasHydrated`, and
 * resets the store on assistant switch.
 *
 * Mounted on `RootLayout`. No `refetchInterval` — the rest of the app
 * reads from the store hydrated from registry defaults + localStorage
 * overrides + this one server response. Live updates while the
 * Developer panel is open are layered on by
 * {@link useAssistantFeatureFlagPolling} using the same query key.
 *
 * Pre-cleanup behaviour was a 5s poll from this exact location, which
 * showed up as one of the dominant request types in the network log
 * and made SSE debugging noisy on every authenticated route. Dropping
 * `refetchInterval` here is the perf win; preserving `markHydrated()`
 * on first response is what keeps `PluginsPage` / `IntelligenceLayout`
 * gating correct.
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

  const { data } = useQuery({
    queryKey: flagValuesQueryKey(assistantId),
    queryFn: () => fetchAssistantFlagValues(assistantId!),
    enabled,
    staleTime: 5_000,
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

/**
 * Developer-panel-only "live refresh" observer. Same query key as
 * {@link useAssistantFeatureFlagSync}, just adds a 5s
 * `refetchInterval` while mounted. TanStack Query dedupes the fetch,
 * so refetches only happen while the panel is open — and the sync
 * hook on `RootLayout` is what writes the refetched values back to
 * the store.
 *
 * Caller supplies `assistantId` directly (e.g. from
 * `assistantsActiveRetrieveOptions()`); the panel sits below
 * `SettingsLayout` which doesn't propagate the root outlet context,
 * so a parameter is simpler than adding a parallel tracker.
 */
export function useAssistantFeatureFlagPolling(assistantId: string | null) {
  const enabled = assistantId !== null;

  useQuery({
    queryKey: flagValuesQueryKey(assistantId),
    queryFn: () => fetchAssistantFlagValues(assistantId!),
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });
}
