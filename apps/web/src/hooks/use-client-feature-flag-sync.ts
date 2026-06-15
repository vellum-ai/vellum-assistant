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
      const { boolFlags, stringFlags } = mapFlags(data.flags);
      const store = useClientFeatureFlagStore.getState();
      store.setFlags(boolFlags);
      if (Object.keys(stringFlags).length > 0) {
        store.setStringFlags(stringFlags);
      }
    }
  }, [data]);
}

const ACTIVATION_FLOW_STORE_KEY = "experimentActivationFlow20260603";
const ACTIVATION_FLOW_LS_KEY = `vellum:ff-str:${ACTIVATION_FLOW_STORE_KEY}`;

function readActivationFlowOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ACTIVATION_FLOW_LS_KEY);
  } catch {
    return null;
  }
}

/**
 * Resolves the `experiment-activation-flow-2026-06-03` arm for the pre-auth
 * sign-up pages, with `settled` indicating the server fetch has completed.
 *
 * Reads the value DIRECTLY from the flag query data (not the store) so the
 * decision never races the store write: React runs child effects before parent
 * effects, so a consumer's redirect effect would otherwise fire before
 * `AccountLayout`'s sync writes the store, reading a stale default. Precedence:
 * a local `localStorage` override wins (for testing), then the server-synced
 * value, then `control`. Callers should hold off acting until `settled`.
 */
export function useActivationFlowArm(): { arm: string; settled: boolean } {
  const freshness = useFlagQueryFreshness();
  const { data, isFetched } = useQuery({
    queryKey: CLIENT_FLAG_QUERY_KEY,
    queryFn: fetchClientFlagValues,
    ...freshness,
    retry: 1,
  });
  const override = readActivationFlowOverride();
  const synced = data?.flags
    ? mapFlags(data.flags).stringFlags[ACTIVATION_FLOW_STORE_KEY]
    : undefined;
  return { arm: override ?? synced ?? "control", settled: isFetched };
}
