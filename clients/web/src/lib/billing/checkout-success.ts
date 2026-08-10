import type { QueryClient } from "@tanstack/react-query";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { t } from "@/i18n";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * Success landing shared by every completed-checkout return path: toast
 * the payment confirmation and refetch the billing summary so the credit
 * balance catches up. Callers are the web return handler
 * (`BillingStatusHandler` consuming `billing_status=success`) and the
 * native `flow=top_up` checkout-complete deep link
 * (`useGlobalDeepLinkConsumer`); one function keeps the copy and the
 * refresh semantics from drifting between them.
 *
 * The stable toast id lets a re-fired return replace the toast instead
 * of stacking a second one.
 */
export function notifyCheckoutSuccess(queryClient: QueryClient): void {
  toast.success(t("settings:billingStatusHandler.successToast"), {
    id: "billing-status",
  });
  void queryClient.invalidateQueries({
    queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
  });
}
