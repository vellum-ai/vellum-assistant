import { toast } from "@vellumai/design-library/components/toast";

import { useSubscriptionAction } from "@/domains/settings/billing/use-subscription-action";
import { formatGraceDate } from "@/domains/settings/hooks/use-billing-portal-session";
import { useOrganizationsBillingSubscriptionCancelCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import type {
  SubscriptionCancelRequestRequest,
  SubscriptionCancelResponse,
} from "@/generated/api/types.gen";
import { t } from "@/i18n";

/**
 * Shared wiring for the "Downgrade to Base" confirms (adjust-plan modal, plans
 * takeover). Posts to the subscription-cancel endpoint, which schedules the
 * Pro sub to end at the current period boundary server-side, and toasts the
 * end date. A `no_op` (cancellation already pending, e.g. scheduled earlier
 * via the portal) reads the same to the user, so it shares the success toast.
 *
 * `body` carries the cancel survey (`feedback` from Stripe's vocabulary plus
 * an optional comment); the endpoint forwards it to Stripe as
 * `cancellation_details`, which feeds the admin revenue dashboard's
 * pending-cancellations reason column.
 */
export function useCancelSubscription() {
  const mutation = useOrganizationsBillingSubscriptionCancelCreateMutation();
  const runSubscriptionAction = useSubscriptionAction();

  const cancelSubscription = (
    body: SubscriptionCancelRequestRequest,
  ): Promise<SubscriptionCancelResponse | null> =>
    runSubscriptionAction({
      mutateAsync: () => mutation.mutateAsync({ body }),
      onSuccess: (result) => {
        const date = result.cancel_at
          ? formatGraceDate(result.cancel_at)
          : t("settings:useCancelSubscription.endOfBillingPeriod");
        toast.info(
          t("settings:useCancelSubscription.canceledToast", { date }),
          { id: "subscription-cancel" },
        );
      },
      errorToastId: "subscription-cancel-error",
      errorFallback: () =>
        t("settings:useCancelSubscription.cancelFailedToast"),
    });

  return { cancelSubscription, isPending: mutation.isPending };
}
