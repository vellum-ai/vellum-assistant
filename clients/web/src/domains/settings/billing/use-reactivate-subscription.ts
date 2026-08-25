import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import {
  organizationsBillingSubscriptionRetrieveQueryKey,
  useOrganizationsBillingSubscriptionReactivateCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionReactivateResponse } from "@/generated/api/types.gen";
import { t } from "@/i18n";

import { extractMutationError } from "@/domains/settings/components/adjust-plan-utils";

/**
 * Shared wiring for the reactivate CTAs (grace-period banner, adjust-plan
 * modal's "Keep your Plan"). Posts to the subscription-reactivate endpoint,
 * which removes the pending cancellation server-side (no Stripe portal
 * round-trip), then invalidates the subscription read so the cleared
 * `cancel_at_period_end` / `cancel_at` state surfaces everywhere, and toasts.
 * A `no_op` (no cancellation pending, e.g. already reactivated elsewhere)
 * reads the same to the user, so it shares the success toast. Errors toast
 * and resolve null so the CTA stays available for a retry.
 */
export function useReactivateSubscription() {
  const queryClient = useQueryClient();
  const mutation =
    useOrganizationsBillingSubscriptionReactivateCreateMutation();

  const reactivateSubscription =
    async (): Promise<SubscriptionReactivateResponse | null> => {
      try {
        const result = await mutation.mutateAsync({});
        await queryClient.invalidateQueries({
          queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
        });
        toast.success(
          t("settings:useReactivateSubscription.reactivatedToast"),
          { id: "subscription-reactivate" },
        );
        return result;
      } catch (error) {
        toast.error(
          extractMutationError(
            error,
            t("settings:useReactivateSubscription.reactivateFailedToast"),
          ),
          { id: "subscription-reactivate-error" },
        );
        return null;
      }
    };

  return { reactivateSubscription, isPending: mutation.isPending };
}
