import { toast } from "@vellumai/design-library/components/toast";

import { useSubscriptionAction } from "@/domains/settings/billing/use-subscription-action";
import { useOrganizationsBillingSubscriptionReactivateCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionReactivateResponse } from "@/generated/api/types.gen";
import { t } from "@/i18n";

/**
 * Shared wiring for the reactivate CTAs (grace-period banner, adjust-plan
 * modal's "Keep your Plan"). Posts to the subscription-reactivate endpoint,
 * which removes the pending cancellation server-side. A `no_op` (no
 * cancellation pending, e.g. already reactivated elsewhere) reads the same to
 * the user, so it shares the success toast.
 */
export function useReactivateSubscription() {
  const mutation =
    useOrganizationsBillingSubscriptionReactivateCreateMutation();
  const runSubscriptionAction = useSubscriptionAction();

  const reactivateSubscription =
    (): Promise<SubscriptionReactivateResponse | null> =>
      runSubscriptionAction({
        mutateAsync: () => mutation.mutateAsync({}),
        onSuccess: () => {
          toast.success(
            t("settings:useReactivateSubscription.reactivatedToast"),
            { id: "subscription-reactivate" },
          );
        },
        errorToastId: "subscription-reactivate-error",
        errorFallback: () =>
          t("settings:useReactivateSubscription.reactivateFailedToast"),
      });

  return { reactivateSubscription, isPending: mutation.isPending };
}
