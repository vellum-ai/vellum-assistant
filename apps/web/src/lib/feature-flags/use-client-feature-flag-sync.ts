import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen.js";
import { assertHasResponse } from "@/lib/api-errors.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import {
  defaultsForScope,
  type ClientFeatureFlags,
} from "@/lib/feature-flags/feature-flag-catalog.js";

interface ClientFlagValuesResponse {
  flags: Record<string, boolean>;
}

const CLIENT_DEFAULTS = defaultsForScope("client");

const NORMALIZED_TO_STORE_KEY: Record<string, keyof ClientFeatureFlags> = {};
for (const key of Object.keys(CLIENT_DEFAULTS) as (keyof ClientFeatureFlags)[]) {
  NORMALIZED_TO_STORE_KEY[key.toLowerCase()] = key;
}

function ldKeyToStoreKey(ldKey: string): keyof ClientFeatureFlags | undefined {
  return NORMALIZED_TO_STORE_KEY[ldKey.replace(/-/g, "").toLowerCase()];
}

const CLIENT_FLAG_QUERY_KEY = ["client-feature-flag-values"] as const;

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
): Partial<ClientFeatureFlags> {
  const mapped: Partial<ClientFeatureFlags> = {};
  for (const [ldKey, value] of Object.entries(serverFlags)) {
    const storeKey = ldKeyToStoreKey(ldKey);
    if (storeKey) {
      Object.assign(mapped, { [storeKey]: value });
    }
  }
  return mapped;
}

export function useClientFeatureFlagSync(enabled: boolean) {
  const { data } = useQuery({
    queryKey: CLIENT_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      useClientFeatureFlagStore.getState().setFlags(mapFlags(data.flags));
    }
  }, [data]);
}
