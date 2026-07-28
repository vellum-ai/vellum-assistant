import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { featureFlagsClientFlagValuesRetrieve } from "@/generated/api/sdk.gen";
import type { ClientFeatureFlagsResponse } from "@/generated/api/types.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
  flagKeyToStoreKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";
import { featureFlagsClientFlagValuesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { isRemoteGatewayMode } from "@/lib/local-mode";

const VALID_BOOL_KEYS = new Set(Object.keys(CLIENT_FLAG_DEFAULTS));
const VALID_STRING_KEYS = new Set(Object.keys(CLIENT_STRING_FLAG_DEFAULTS));

/** A flag evaluation together with the identity it was evaluated against. */
interface ScopedClientFlagValues {
  scopeKey: string | null;
  flags: ClientFeatureFlagsResponse["flags"];
}

async function fetchClientFlagValues(): Promise<ScopedClientFlagValues> {
  // Stamp the request with the scope it goes out under. The response is applied
  // from a passive effect, by which point the identity may have moved on, and
  // the stamp is what lets the store tell whose answer it is holding.
  const scopeKey = useClientFeatureFlagStore.getState().scopeKey;
  const { data, error, response } = await featureFlagsClientFlagValuesRetrieve({
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch client feature flags");
  if (!response.ok || !data) {
    throw new Error(`Failed to fetch client feature flags: ${response.status}`);
  }
  return { scopeKey, flags: data.flags };
}

function mapFlags(serverFlags: Record<string, boolean | string>): {
  boolFlags: Record<string, boolean>;
  stringFlags: Record<string, string>;
} {
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
  const freshness = useFlagQueryFreshness();
  // The client-flag endpoint evaluates against the signed-in user + org, so an
  // authenticated request without `Vellum-Organization-Id` is rejected. The org
  // store hydrates asynchronously after auth, so an authenticated cold load can
  // reach here before the header source can answer.
  const orgReadiness = useOrgHeaderReadiness();
  // The identity in force for this render, and so the one the settle decision
  // below is about. Captured here rather than read in the effect, which runs
  // after a scope change may already have claimed a different one.
  const claimedScopeKey = useClientFeatureFlagStore.use.scopeKey();
  const modeAllowsFetch = enabled && !isRemoteGatewayMode();
  const shouldFetch = modeAllowsFetch && orgReadiness === "ready";
  const { data, isError } = useQuery({
    queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
    queryFn: fetchClientFlagValues,
    enabled: shouldFetch,
    ...freshness,
    retry: 1,
  });

  useEffect(() => {
    if (data?.flags) {
      const { boolFlags, stringFlags } = mapFlags(data.flags);
      const store = useClientFeatureFlagStore.getState();
      store.setFlags(boolFlags, data.scopeKey);
      if (Object.keys(stringFlags).length > 0) {
        store.setStringFlags(stringFlags, data.scopeKey);
      }
      return;
    }
    if (!enabled) {
      // The session hasn't settled, so no answer is due yet.
      return;
    }
    // Settle only when no server values are *coming*, never merely because none
    // have arrived. Three ways nothing is coming: this mode never fetches, the
    // org header the request needs will never arrive, or the fetch ran and
    // failed. A fetch that simply hasn't happened yet — org still resolving —
    // is none of them: settling there would publish the default-off registry
    // value as the answer and bounce a valid pricing deep link to plans before
    // the real value could land. `"unavailable"` is the bound on that wait; the
    // org store reaches a terminal `ready`/`error` on every fetch outcome.
    // The store decides what to settle on — registry defaults when this scope
    // never got a response, its last values when a refresh failed after one.
    if (!modeAllowsFetch || orgReadiness === "unavailable" || isError) {
      useClientFeatureFlagStore
        .getState()
        .settleWithoutServerValues(claimedScopeKey);
    }
  }, [claimedScopeKey, data, enabled, isError, modeAllowsFetch, orgReadiness]);
}
