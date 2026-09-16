import { Plus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { type TFunction, useTranslation } from "@/i18n";
import { formatMonthDay } from "@/utils/format-date";

/**
 * The end of the billing cycle the panel dates itself by. A sub holding a
 * credit bundle sees that bundle reset then: the platform expires each
 * bundle grant at its period end and burns it before any other grant, so the
 * bar returns to zero for a sub that never ran its bundle out. A sub holding
 * no bundle only renews, because nothing it holds turns over. This is the one
 * statement of that distinction; every other site points here.
 */
export interface UsagePeriodEnd {
  /** ISO instant the current cycle ends on. */
  at: string;
  kind: "resets" | "renews";
}

export interface UsageBalancePanelProps {
  /** Used share of the granted usage credit, already clamped to 0..1. */
  ratio: number;
  /**
   * The cycle end printed under the title; see {@link UsagePeriodEnd}.
   * Omitted for the free plan and for a sub that is not renewing.
   */
  periodEnd?: UsagePeriodEnd;
  /**
   * The wallet behind the spent bundle is empty too, so the next turn has
   * nothing to draw on. Raises the add-credits strip, and only that: the bar
   * and the percentage read the negative state off `ratio` alone.
   */
  exhausted?: boolean;
  /** Opens the add-credits checkout. Omitted, the strip states its case only. */
  onAddCredits?: () => void;
}

/** The cycle-end wording: the line under the title, and the bar's accessible name folding it in. */
export interface UsagePeriodEndLabels {
  line: string;
  barLabel: string;
}

/**
 * The cycle-end wording the panel and the tile's price row share, so the
 * label reads the same whether or not a usage reading loaded, and follows
 * `periodEnd.kind` in one place. Null when there is no instant to date, or
 * one that will not parse, so a caller drops the line.
 */
export function usagePeriodEndLabels(
  periodEnd: UsagePeriodEnd | undefined,
  t: TFunction<"settings">,
): UsagePeriodEndLabels | null {
  if (!periodEnd) {
    return null;
  }
  const date = formatMonthDay(periodEnd.at);
  if (!date) {
    return null;
  }
  if (periodEnd.kind === "resets") {
    return {
      line: t("planCard.usageBalanceResets", { date }),
      barLabel: t("planCard.usageBalanceBarResets", { date }),
    };
  }
  return {
    line: t("planCard.usageBalanceRenews", { date }),
    barLabel: t("planCard.usageBalanceBarRenews", { date }),
  };
}

/**
 * The current-plan tile's footer, in place of the price row: how much of the
 * usage credit the account was granted it has already used, over the date its
 * cycle ends on.
 */
export function UsageBalancePanel({
  ratio,
  periodEnd,
  exhausted = false,
  onAddCredits,
}: UsageBalancePanelProps) {
  const { t } = useTranslation("settings");
  const title = t("planCard.usageBalanceTitle");
  const periodEndLabels = usagePeriodEndLabels(periodEnd, t);
  // The bar's accessible name is one complete message per variant rather than
  // the title and the date line joined here: the joining punctuation is the
  // translator's, not ours.
  const barLabel = periodEndLabels?.barLabel ?? title;
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
        about 514px of panel, above which the bar takes a 64px gap after the
        title and stretches to the percentage. Below it the gap tightens so
        the bar keeps its length on phones.
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
          {periodEndLabels ? (
            <Typography
              as="span"
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
              data-testid="plan-usage-period-end"
            >
              {periodEndLabels.line}
            </Typography>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProgressBar
            value={ratio}
            height={8}
            aria-label={barLabel}
            fillColor={spent ? "var(--system-negative-strong)" : undefined}
            className="w-full min-w-0 rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
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
