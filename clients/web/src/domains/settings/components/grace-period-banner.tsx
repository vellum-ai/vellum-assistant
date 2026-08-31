import { Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { useReactivateSubscription } from "@/domains/settings/billing/use-reactivate-subscription";
import { isDirectCancelEligible } from "@/domains/settings/components/adjust-plan-utils";
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { openBillingPathInBrowser } from "@/lib/billing/android-billing-handoff";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

/**
 * In-flow banner shown on the billing settings surface when the org's Pro
 * subscription is mid-grace-period, i.e. cancellation has been scheduled,
 * either via `cancel_at_period_end=true` or via an explicit `cancel_at`
 * timestamp set by Stripe (the Customer Portal uses the latter). The
 * "Reactivate" CTA posts the subscription-reactivate endpoint directly; the
 * shared hook invalidates the subscription read, so the banner clears itself
 * once the cancellation is removed. A Pro sub the endpoint rejects
 * (non-entitlement status) keeps the Stripe portal handoff, which can still
 * reactivate it.
 */
export function GracePeriodBanner() {
  const { t } = useTranslation("settings");
  // Native Android reactivates on the web app's billing page in the browser
  // instead of managing the subscription from inside the app.
  const isNativeAndroid = useIsNativeAndroid();
  const { data } = useQuery(organizationsBillingSubscriptionRetrieveOptions());

  const snapshot = useMemo(() => buildPortalReturnSnapshot(data), [data]);
  const portalMutation = useBillingPortalSession(snapshot);
  const { reactivateSubscription, isPending: reactivatePending } =
    useReactivateSubscription();
  const isPending = reactivatePending || portalMutation.isPending;

  if (
    !data ||
    data.plan_id !== "pro" ||
    data.status === "canceled" ||
    (!data.cancel_at_period_end && !data.cancel_at)
  ) {
    return null;
  }
  const cancelDate = getEffectiveCancelDate(data);
  if (!cancelDate) {
    return null;
  }
  const formatted = formatGraceDate(cancelDate);

  return (
    <Notice
      tone="info"
      title={t("gracePeriodBanner.title", { date: formatted })}
      actions={
        <Button
          variant="outlined"
          size="compact"
          onClick={() => {
            if (isNativeAndroid) {
              openBillingPathInBrowser(routes.settings.usageBilling);
              return;
            }
            if (!isDirectCancelEligible(data)) {
              portalMutation.mutate({});
              return;
            }
            void reactivateSubscription();
          }}
          disabled={isPending}
          leftIcon={
            isPending ? <Loader2 className="animate-spin" /> : undefined
          }
          data-testid="grace-period-reactivate-button"
        >
          {t("gracePeriodBanner.reactivate")}
        </Button>
      }
      data-testid="grace-period-banner"
    >
      {t("gracePeriodBanner.body")}
    </Notice>
  );
}
