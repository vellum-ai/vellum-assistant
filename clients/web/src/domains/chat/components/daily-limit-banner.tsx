import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { organizationsBillingAutoTopUpRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useSkipDailyLimitToday } from "@/hooks/use-daily-limit-skip";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

interface DailyLimitBannerProps {
  onAdjustLimit: () => void;
}

/** Format a USD decimal string ("25.00") as "$25.00" for display copy. */
function formatUsd(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${value}`;
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
 * the full explanation lives — what stops applying, for how long, and (when
 * relevant) that auto top-up keeps charging — so the banner itself stays two
 * short buttons instead of a paragraph.
 */
export function DailyLimitBanner({ onAdjustLimit }: DailyLimitBannerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { dailyLimit, dailySpend } = useBillingBalanceStatus();
  const skipMutation = useSkipDailyLimitToday();

  // Only claim that top-ups will keep charging when we positively know they
  // are on. An errored or in-flight query means we do not know, and a
  // confident-but-wrong statement about someone's card is worse than omitting
  // the line — the billing settings page states this authoritatively either way.
  const autoTopUpQuery = useQuery(
    organizationsBillingAutoTopUpRetrieveOptions(),
  );
  const autoTopUpOn =
    autoTopUpQuery.data?.enabled === true && !autoTopUpQuery.isError;

  const resetPhrase = dailyResetTimePhrase();
  const limitDisplay = formatUsd(dailyLimit);
  const spendDisplay = formatUsd(dailySpend);

  const handleConfirmSkip = () => {
    skipMutation.mutate(
      {},
      {
        // The banner unmounts as soon as the refreshed summary reports the
        // limit is no longer reached, so closing here only matters when the
        // request fails.
        onSettled: () => setConfirmOpen(false),
      },
    );
  };

  return (
    <>
      <BillingErrorBanner
        ariaLabel="Daily credit limit reached"
        icon={
          <CalendarClock
            className="size-5"
            style={{ color: "var(--content-tertiary)" }}
          />
        }
        title="Daily credit limit reached"
        subtitle={`Vellum credit spend is paused until your limit resets at ${resetPhrase}.`}
        secondaryAction={{
          label: "Skip for today",
          onClick: () => setConfirmOpen(true),
          disabled: skipMutation.isPending,
        }}
        action={{ label: "Settings", onClick: onAdjustLimit }}
      />
      <ConfirmDialog
        open={confirmOpen}
        title="Skip today's credit limit?"
        message={
          <>
            {limitDisplay
              ? `Your ${limitDisplay} daily limit won't apply for the rest of today`
              : "Your daily limit won't apply for the rest of today"}
            {spendDisplay ? ` — you've spent ${spendDisplay} so far` : ""}. It
            comes back automatically at {resetPhrase}.
            {autoTopUpOn
              ? " Automatic top-ups stay on, so your card can be charged again today."
              : ""}
          </>
        }
        confirmLabel="Skip for today"
        isPending={skipMutation.isPending}
        onConfirm={handleConfirmSkip}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
