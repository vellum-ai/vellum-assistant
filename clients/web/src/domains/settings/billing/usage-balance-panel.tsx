import { Plus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import { formatMonthDay } from "@/utils/format-date";

export interface UsageBalancePanelProps {
  /** Used share of the granted usage credit, already clamped to 0..1. */
  ratio: number;
  /**
   * ISO instant the subscription's current period ends on. The meter
   * aggregates grants with different lifetimes, so the line dates the
   * subscription's renewal and never claims the meter resets. Omitted for the
   * free plan and for a sub that is not renewing.
   */
  periodEnd?: string;
  /**
   * The wallet behind the spent bundle is empty too, so the next turn has
   * nothing to draw on. Raises the add-credits strip, and only that: the bar
   * and the percentage read the negative state off `ratio` alone.
   */
  exhausted?: boolean;
  /** Opens the add-credits checkout. Omitted, the strip states its case only. */
  onAddCredits?: () => void;
}

/**
 * The current-plan tile's footer, in place of the price row: how much of the
 * usage credit the account was granted it has already used, over the date the
 * subscription renews.
 */
export function UsageBalancePanel({
  ratio,
  periodEnd,
  exhausted = false,
  onAddCredits,
}: UsageBalancePanelProps) {
  const { t } = useTranslation("settings");
  const title = t("planCard.usageBalanceTitle");
  // An instant that will not parse leaves no date to print, so both labels
  // fall back to the undated wording.
  const periodEndDate = periodEnd ? formatMonthDay(periodEnd) : null;
  const periodEndLabel = periodEndDate
    ? t("planCard.usageBalanceRenews", { date: periodEndDate })
    : null;
  // The bar's accessible name is one complete message rather than the title
  // and the date line joined here: the joining punctuation is the
  // translator's, not ours.
  const barLabel = periodEndDate
    ? t("planCard.usageBalanceBarRenews", { date: periodEndDate })
    : title;
  const pct = Math.round(ratio * 100);
  // Spending the whole bundle is the negative reading in its own right,
  // whatever the wallet behind it still holds.
  const spent = ratio >= 1;

  return (
    // No fill: the panel sits on the tile's own surface and the border alone
    // groups it.
    <div
      data-testid="plan-usage-balance"
      className="@container flex w-full flex-col gap-3 rounded-[10px] border border-[var(--border-base)] px-4 py-3"
    >
      {/*
        Container query, not a viewport breakpoint: the tile is half a card
        beside a next tile and the whole card without one, so the viewport says
        nothing about the panel's width. The threshold is the content box,
        about 514px of panel, where the 64px gap and the full-length bar first
        both fit. Below it the bar stays right-aligned and shrinks, which is
        what phones need.
      */}
      <div className="flex w-full items-center gap-3 @min-[30rem]:gap-16">
        <div className="flex min-w-0 flex-col">
          <Typography
            as="span"
            variant="body-large-default"
            className="text-[var(--content-emphasised)]"
          >
            {title}
          </Typography>
          {periodEndLabel ? (
            <Typography
              as="span"
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
              data-testid="plan-usage-period-end"
            >
              {periodEndLabel}
            </Typography>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 @min-[30rem]:justify-start">
          <ProgressBar
            value={ratio}
            height={8}
            aria-label={barLabel}
            fillColor={spent ? "var(--system-negative-strong)" : undefined}
            className="w-full min-w-0 max-w-[249px] rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
          />
          <Typography
            as="span"
            variant="body-small-default"
            className={
              spent
                ? "whitespace-nowrap text-[var(--system-negative-strong)]"
                : "whitespace-nowrap text-[var(--content-secondary)]"
            }
          >
            {t("planCard.usageBalancePctUsed", { pct })}
          </Typography>
        </div>
      </div>
      {exhausted ? (
        <div className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md bg-[var(--system-negative-weak)] px-2 py-1">
          <Typography
            as="span"
            variant="body-medium-default"
            className="min-w-0 text-[var(--system-negative-strong)]"
          >
            {t("planCard.usageBalanceExhausted")}
          </Typography>
          {onAddCredits ? (
            <div className="flex shrink-0 items-center gap-2">
              <span
                aria-hidden
                className="h-[18px] w-px bg-[var(--system-negative-strong)] opacity-30"
              />
              <Button
                variant="dangerGhost"
                size="compact"
                leftIcon={<Plus />}
                onClick={onAddCredits}
                data-testid="plan-usage-add-credits"
              >
                {t("planCard.usageBalanceAddCredits")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
