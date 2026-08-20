import { Plus, Settings as SettingsIcon } from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import {
  includedMonthlyCreditsUsdFromPlans,
  usePlanUsageBalance,
} from "@/hooks/use-plan-usage-balance";
import { useTranslation } from "@/i18n";

export interface PreferencesUsagePanelProps {
  /** Opens the Billing tab of the usage settings page. */
  onOpenBilling: () => void;
  /** Opens the add-credits checkout. */
  onAddCredits: () => void;
}

/**
 * The preferences menu's usage reading while `obscure-credits` is on: the same
 * share of the included bundle the billing Plan tile draws, close to where the
 * work is being done. Renders nothing when the flag is off, when the org has no
 * managed billing to read, or before an honest number lands, so the menu is
 * otherwise exactly what it has always been.
 */
export function PreferencesUsagePanel({
  onOpenBilling,
  onAddCredits,
}: PreferencesUsagePanelProps) {
  const { t, i18n } = useTranslation("chat");
  const obscureCredits = useObscureCredits();
  const { isExhausted, enabled: billingEnabled } = useBillingBalanceStatus();
  // The plan catalog and the sub are only worth fetching when the flag is on
  // and the org actually has managed billing; the usage read behind them gates
  // itself the same way.
  const enabled = obscureCredits && billingEnabled;
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled,
  });
  const plansQuery = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled,
  });
  const usage = usePlanUsageBalance({
    subscription: subscriptionQuery.data,
    includedCreditsUsd: includedMonthlyCreditsUsdFromPlans(
      subscriptionQuery.data,
      plansQuery.data?.plans,
    ),
  });

  if (!enabled || !usage) {
    return null;
  }

  const title = t("preferencesUsagePanel.title");
  const pct = Math.round(usage.ratio * 100);
  const resetDate = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
  }).format(new Date(usage.resetsAt));
  // Spending the bundle only alarms once the wallet behind it is empty too.
  const exhausted = usage.ratio >= 1 && isExhausted;

  return (
    <div className="my-2 flex flex-col gap-1" data-testid="preferences-usage">
      <div className="flex flex-col gap-2 rounded-lg bg-[var(--surface-base)] px-2 pb-2.5 pt-3">
        <div className="flex items-center justify-between gap-2">
          <Typography
            as="span"
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {title}
          </Typography>
          <div className="flex shrink-0 items-center gap-1.5">
            <Typography
              as="span"
              variant="body-small-default"
              className={
                exhausted
                  ? "whitespace-nowrap text-[var(--system-negative-strong)]"
                  : "whitespace-nowrap text-[var(--content-secondary)]"
              }
            >
              {t("preferencesUsagePanel.pctUsed", { pct })}
            </Typography>
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<SettingsIcon />}
              expandOnMobile={false}
              aria-label={t("preferencesUsagePanel.settingsAriaLabel")}
              onClick={onOpenBilling}
              data-testid="preferences-usage-settings"
            />
          </div>
        </div>
        <ProgressBar
          value={usage.ratio}
          height={10}
          aria-label={title}
          fillColor={exhausted ? "var(--system-negative-strong)" : undefined}
          className="w-full rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
        />
        <Typography
          as="span"
          variant="label-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {t("preferencesUsagePanel.resets", { date: resetDate })}
        </Typography>
      </div>
      {exhausted ? (
        <div className="flex min-h-8 items-center justify-between gap-2 rounded-lg bg-[var(--system-negative-weak)] px-2 py-1">
          <Typography
            as="span"
            variant="body-medium-default"
            className="min-w-0 text-[var(--system-negative-strong)]"
          >
            {t("preferencesUsagePanel.exhausted")}
          </Typography>
          <div className="flex shrink-0 items-center gap-2">
            <span
              aria-hidden
              className="h-[18px] w-px bg-[var(--system-negative-strong)] opacity-30"
            />
            <Button
              variant="dangerGhost"
              size="compact"
              iconOnly={<Plus />}
              expandOnMobile={false}
              aria-label={t("preferencesUsagePanel.addCreditsAriaLabel")}
              onClick={onAddCredits}
              data-testid="preferences-usage-add-credits"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
