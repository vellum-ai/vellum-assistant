import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import {
  DEFAULT_FLAGS,
  useFeatureFlagStore,
  type AppFeatureFlags,
} from "@/lib/feature-flags/feature-flag-store.js";

interface ClientFlagValuesResponse {
  flags: Record<string, boolean>;
}

const NORMALIZED_TO_STORE_KEY: Record<string, keyof AppFeatureFlags> = {};
for (const key of Object.keys(DEFAULT_FLAGS) as (keyof AppFeatureFlags)[]) {
  NORMALIZED_TO_STORE_KEY[key.toLowerCase()] = key;
}

function ldKeyToStoreKey(ldKey: string): keyof AppFeatureFlags | undefined {
  return NORMALIZED_TO_STORE_KEY[ldKey.replace(/-/g, "").toLowerCase()];
}

const FEATURE_FLAG_QUERY_KEY = ["feature-flag-values"] as const;

async function fetchClientFlagValues(): Promise<ClientFlagValuesResponse> {
  const { data, error, response } = await client.get<
    ClientFlagValuesResponse,
    Record<string, unknown>,
    false
  >({
    url: `/v1/feature-flags/client-flag-values/`,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch feature flags");
  if (!response.ok) {
    throw new Error(`Failed to fetch feature flags: ${response.status}`);
  }
  return data as ClientFlagValuesResponse;
}

function mapFlags(
  serverFlags: Record<string, boolean>,
): Partial<AppFeatureFlags> {
  const mapped: Partial<AppFeatureFlags> = {};
  for (const [ldKey, value] of Object.entries(serverFlags)) {
    const storeKey = ldKeyToStoreKey(ldKey);
    if (storeKey) {
      Object.assign(mapped, { [storeKey]: value });
    }
  }
  return mapped;
}

export function useFeatureFlagSync(enabled: boolean) {
  const { data } = useQuery({
    queryKey: FEATURE_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      useFeatureFlagStore.getState().setFlags(mapFlags(data.flags));
    }
  }, [data]);
}
