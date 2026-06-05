import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { featureFlagsClientFlagValuesRetrieve } from "@/generated/api/sdk.gen";
import type { ClientFeatureFlagsResponse } from "@/generated/api/types.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
  CLIENT_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/sync/query-tags";

const VALID_KEYS = new Set(Object.keys(CLIENT_FLAG_DEFAULTS));

async function fetchClientFlagValues(): Promise<ClientFeatureFlagsResponse> {
  const { data, error, response } = await featureFlagsClientFlagValuesRetrieve({
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch client feature flags");
  if (!response.ok || !data) {
    throw new Error(`Failed to fetch client feature flags: ${response.status}`);
  }
  return data;
}

function mapFlags(
  serverFlags: Record<string, boolean | string>,
): Record<string, boolean> {
  const mapped: Record<string, boolean> = {};
  for (const [flagKey, value] of Object.entries(serverFlags)) {
    if (typeof value !== "boolean") continue;
    const storeKey = flagKeyToStoreKey(flagKey);
    if (VALID_KEYS.has(storeKey)) {
      mapped[storeKey] = value;
    }
  }
  return mapped;
}

export function useClientFeatureFlagSync(enabled: boolean) {
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
