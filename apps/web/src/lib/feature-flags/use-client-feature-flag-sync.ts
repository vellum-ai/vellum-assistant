import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import {
  CLIENT_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog.js";
import { useFlagQueryFreshness } from "@/lib/feature-flags/flag-query-freshness.js";

interface ClientFlagValuesResponse {
  flags: Record<string, boolean>;
}

const VALID_KEYS = new Set(Object.keys(CLIENT_FLAG_DEFAULTS));

export const CLIENT_FLAG_QUERY_KEY = ["client-feature-flag-values"] as const;

async function fetchClientFlagValues(): Promise<ClientFlagValuesResponse> {
  const { data, error, response } = await client.get<
    ClientFlagValuesResponse,
    Record<string, unknown>,
    false
  >({
    url: `/v1/feature-flags/client-flag-values/`,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch client feature flags");
  if (!response.ok) {
    throw new Error(`Failed to fetch client feature flags: ${response.status}`);
  }
  return data as ClientFlagValuesResponse;
}

function mapFlags(
  serverFlags: Record<string, boolean>,
): Record<string, boolean> {
  const mapped: Record<string, boolean> = {};
  for (const [flagKey, value] of Object.entries(serverFlags)) {
    const storeKey = flagKeyToStoreKey(flagKey);
    if (VALID_KEYS.has(storeKey)) {
      mapped[storeKey] = value;
    }
  }
  return mapped;
}

export function useClientFeatureFlagSync(enabled: boolean) {
  // Freshness options are version-gated by the active assistant's
  // daemon version: assistants on 0.8.5+ rely on the SSE push +
  // `sse.opened` reconnect invalidation (see `useAssistantSyncStream`),
  // older assistants fall back to a 5s interval poll. See
  // `flag-query-freshness.ts` for the rationale.
  const freshness = useFlagQueryFreshness();
  const { data } = useQuery({
    queryKey: CLIENT_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    enabled,
    ...freshness,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      useClientFeatureFlagStore.getState().setFlags(mapFlags(data.flags));
    }
  }, [data]);
}
