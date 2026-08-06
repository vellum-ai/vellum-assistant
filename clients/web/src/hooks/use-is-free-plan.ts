import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

/**
 * Whether the org is on the FREE plan (`plan_id === "base"`).
 * `undefined` while loading/unresolved — callers treat unknown as "not free"
 * so paid-only affordances never flash for a paying user. `enabled` gates the
 * fetch so surfaces only fetch the subscription when the value is needed, and
 * is folded together with `useIsOrgReady()` so the request never fires before
 * the org store hydrates — the subscription endpoint requires the
 * `Vellum-Organization-Id` header the interceptor only attaches once the active
 * org id is known, so a headerless request on first load would be rejected.
 */
export function useIsFreePlan(enabled = true): boolean | undefined {
  const orgReady = useIsOrgReady();
  const { data } = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: enabled && orgReady,
  });
  if (data?.plan_id == null) {
    return undefined;
  }
  return data.plan_id === "base";
}
