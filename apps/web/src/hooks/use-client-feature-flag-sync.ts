import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { featureFlagsClientFlagValuesRetrieve } from "@/generated/api/sdk.gen";
import type { ClientFeatureFlagsResponse } from "@/generated/api/types.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/sync/query-tags";

const VALID_BOOL_KEYS = new Set(Object.keys(CLIENT_FLAG_DEFAULTS));
const VALID_STRING_KEYS = new Set(Object.keys(CLIENT_STRING_FLAG_DEFAULTS));

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
): { boolFlags: Record<string, boolean>; stringFlags: Record<string, string> } {
  const boolFlags: Record<string, boolean> = {};
  const stringFlags: Record<string, string> = {};
  for (const [flagKey, value] of Object.entries(serverFlags)) {
    const storeKey = flagKeyToStoreKey(flagKey);
    if (typeof value === "boolean" && VALID_BOOL_KEYS.has(storeKey)) {
      boolFlags[storeKey] = value;
    } else if (typeof value === "string" && VALID_STRING_KEYS.has(storeKey)) {
      stringFlags[storeKey] = value;
    }
  }
  return { boolFlags, stringFlags };
}

export function useClientFeatureFlagSync(enabled: boolean) {
  const isOrgReady = useIsOrgReady();
  const freshness = useFlagQueryFreshness();
  const { data } = useQuery({
    queryKey: CLIENT_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    enabled: enabled && isOrgReady,
    ...freshness,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      const { boolFlags, stringFlags } = mapFlags(data.flags);
      const store = useClientFeatureFlagStore.getState();
      store.setFlags(boolFlags);
      if (Object.keys(stringFlags).length > 0) {
        store.setStringFlags(stringFlags);
      }
    }
  }, [data]);
}
