import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "@/i18n";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { organizationsBillingAutoTopUpRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useSkipDailyLimitToday } from "@/hooks/use-daily-limit-skip";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";
import { formatUsd } from "@/utils/format-usd";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

interface DailyLimitBannerProps {
  onAdjustLimit: () => void;
}

/**
 * Composer banner shown while the org's daily credit limit is being enforced.
 *
 * Offers two ways out, weighted deliberately. "Settings" is the filled button
 * because it leads to the control the user set on purpose; "Skip for today" is
 * the ghost button because it removes that guardrail. The whole point of a
 * daily limit is to be a speed bump, so bypassing it should not be the
 * lightest-weight click on screen.
 *
 * The skip is confirmed rather than immediate. That confirm step is also where
 * the full explanation lives: what stops applying, for how long, and (when
 * relevant) that auto top-up keeps charging. The banner itself stays two short
 * buttons instead of a paragraph.
 */
export function DailyLimitBanner({ onAdjustLimit }: DailyLimitBannerProps) {
  const { t } = useTranslation("chat");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { dailyLimit, dailySpend } = useBillingBalanceStatus();
  const skipMutation = useSkipDailyLimitToday();

  // Only claim that top-ups will keep charging when we positively know they
  // are on. An errored or in-flight query means we do not know, and a
  // confident-but-wrong statement about someone's card is worse than omitting
  // the line. The billing settings page states this authoritatively either way.
  const autoTopUpQuery = useQuery(
    organizationsBillingAutoTopUpRetrieveOptions(),
  );
  const autoTopUpOn =
    autoTopUpQuery.data?.enabled === true && !autoTopUpQuery.isError;

  const resetPhrase = dailyResetTimePhrase();
  const limitDisplay = formatUsd(dailyLimit);
  const spendDisplay = formatUsd(dailySpend);

  // Assembled from whole sentences so an unknown amount drops its clause
  // without leaving a double space or a stranded period behind it.
  const confirmMessage = [
    limitDisplay
      ? `Your ${limitDisplay} daily limit won't apply for the rest of today.`
      : "Your daily limit won't apply for the rest of today.",
    spendDisplay ? `You've spent ${spendDisplay} so far.` : null,
    `It comes back automatically at ${resetPhrase}.`,
    autoTopUpOn
      ? "Automatic top-ups stay on, so your card can be charged again today."
      : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");

  const handleConfirmSkip = () => {
    // The dialog closes on success, where the refreshed summary also unmounts
    // the banner. A rejected skip keeps it open carrying the failure, so the
    // user sees that their limit is still in force and can retry in place.
    skipMutation.mutate({}, { onSuccess: () => setConfirmOpen(false) });
  };

  const handleOpenConfirm = () => {
    skipMutation.reset();
    setConfirmOpen(true);
  };

  const handleCancelConfirm = () => {
    skipMutation.reset();
    setConfirmOpen(false);
  };

  return (
    <>
      <BillingErrorBanner
        ariaLabel={t("dailyLimitBanner.title")}
        icon={
          <CalendarClock
            className="size-5"
            style={{ color: "var(--content-tertiary)" }}
          />
        }
        title={t("dailyLimitBanner.title")}
        subtitle={t("dailyLimitBanner.subtitle", { resetPhrase })}
        secondaryAction={{
          label: t("dailyLimitBanner.skipForToday"),
          onClick: handleOpenConfirm,
          disabled: skipMutation.isPending,
        }}
        action={{ label: "Settings", onClick: onAdjustLimit }}
      />
      <ConfirmDialog
        open={confirmOpen}
        title={t("dailyLimitBanner.skipConfirmTitle")}
        message={confirmMessage}
        error={
          skipMutation.isError
            ? t("dailyLimitBanner.skipError")
            : undefined
        }
        confirmLabel={t("dailyLimitBanner.skipForToday")}
        isPending={skipMutation.isPending}
        onConfirm={handleConfirmSkip}
        onCancel={handleCancelConfirm}
      />
    </>
  );
}
