import { useQuery } from "@tanstack/react-query";

import { organizationsBillingAutoTopUpRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

/**
 * The shared auto-top-up config query (saved payment method + auto-reload
 * state), gated on `useIsOrgReady()`: the endpoint requires the
 * `Vellum-Organization-Id` header, which the interceptor only attaches once
 * the active org id is known, so a request fired before the org store
 * hydrates is rejected and the failed result then sits in the shared cache
 * as if the org had no saved card. While gated the query has no data and
 * reports `isPending` without `isLoading`, so consumers must branch on
 * `isPending` for their loading state.
 */
export function useAutoTopUpConfigQuery() {
  const orgReady = useIsOrgReady();
  return useQuery({
    ...organizationsBillingAutoTopUpRetrieveOptions(),
    enabled: orgReady,
  });
}
