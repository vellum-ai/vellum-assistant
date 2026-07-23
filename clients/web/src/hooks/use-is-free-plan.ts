import { useQuery } from "@tanstack/react-query";

import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";

/**
 * Whether the org is on the FREE plan (`plan_id === "base"`).
 * `undefined` while loading/unresolved — callers treat unknown as "not free"
 * so paid-only affordances never flash for a paying user. `enabled` gates the
 * fetch so surfaces only fetch the subscription when the value is needed.
 */
export function useIsFreePlan(enabled = true): boolean | undefined {
  const { data } = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled,
  });
  if (data?.plan_id == null) return undefined;
  return data.plan_id === "base";
}
