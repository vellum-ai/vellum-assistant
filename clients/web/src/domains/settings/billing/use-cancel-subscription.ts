import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import { formatGraceDate } from "@/domains/settings/hooks/use-billing-portal-session";
import {
  organizationsBillingSubscriptionRetrieveQueryKey,
  useOrganizationsBillingSubscriptionCancelCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionCancelResponse } from "@/generated/api/types.gen";
import { t } from "@/i18n";

import { extractMutationError } from "@/domains/settings/components/adjust-plan-utils";

/**
 * Shared wiring for the "Downgrade to Base" confirms (adjust-plan modal, plans
 * takeover). Posts to the subscription-cancel endpoint, which schedules the Pro
 * sub to end at the current period boundary server-side (no Stripe portal
 * round-trip), then invalidates the subscription read so the pending state
 * (`cancel_at_period_end` / `cancel_at`) surfaces everywhere, and toasts the
 * end date. A `no_op` (cancellation already pending, e.g. scheduled earlier via
 * the portal) reads the same to the user, so it shares the success toast.
 * Errors toast and resolve null so the confirm UI can stay open for a retry.
 */
export function useCancelSubscription() {
  const queryClient = useQueryClient();
  const mutation = useOrganizationsBillingSubscriptionCancelCreateMutation();

  const cancelSubscription =
    async (): Promise<SubscriptionCancelResponse | null> => {
      try {
        const result = await mutation.mutateAsync({});
        await queryClient.invalidateQueries({
          queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
        });
        const date = result.cancel_at
          ? formatGraceDate(result.cancel_at)
          : t("settings:useCancelSubscription.endOfBillingPeriod");
        toast.info(
          t("settings:useCancelSubscription.canceledToast", { date }),
          { id: "subscription-cancel" },
        );
        return result;
      } catch (error) {
        toast.error(
          extractMutationError(
            error,
            t("settings:useCancelSubscription.cancelFailedToast"),
          ),
          { id: "subscription-cancel-error" },
        );
        return null;
      }
    };

  return { cancelSubscription, isPending: mutation.isPending };
}
