import { useQuery } from "@tanstack/react-query";

import { organizationsBillingAutoTopUpRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";

/**
 * The shared auto-top-up config query (saved payment method + auto-reload
 * state). Every rendered observer of this query key must come through here:
 * the endpoint needs the `Vellum-Organization-Id` header, which the
 * interceptor only attaches once the active org id is known, and TanStack
 * Query shares one fetch per key across observers, so a single ungated
 * consumer firing before the org store hydrates would land the headerless
 * rejection in the cache for all of them.
 *
 * `"resolving"` holds the query idle: no data, `isPending` without
 * `isLoading`, so consumers branch on `isPending` for their loading state.
 * `"unavailable"` (org resolution failed or produced no org) lets the
 * request fire and fail so consumers surface their error state instead of
 * loading forever.
 */
export function useAutoTopUpConfigQuery() {
  const readiness = useOrgHeaderReadiness();
  return useQuery({
    ...organizationsBillingAutoTopUpRetrieveOptions(),
    enabled: readiness !== "resolving",
  });
}
