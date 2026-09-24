import { Plus } from "lucide-react";

import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { type TFunction, useTranslation } from "@/i18n";
import { formatMonthDay } from "@/utils/format-date";

/**
 * The end of the billing cycle the reading dates itself by. A sub holding a
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
  /** One or more {@link UsageBalanceReading} rows. */
  children: ReactNode;
}

export interface UsageBalanceReadingProps {
  /** Used share of the granted usage credit, already clamped to 0..1. */
  ratio: number;
  /** The reading's name, over the line under it. */
  title: string;
  /**
   * The cycle end printed under the title; see {@link UsagePeriodEnd}.
   * Omitted for the free plan and for a sub that is not renewing.
   */
  periodEnd?: UsagePeriodEnd;
  /** The line under the title. Falls back to the cycle-end wording. */
  line?: string;
  /**
   * The bar's accessible name. Falls back to the cycle-end wording, then to
   * the title.
   */
  barLabel?: string;
  /**
   * The wallet behind the spent bundle is empty too, so the next turn has
   * nothing to draw on. Raises the add-credits strip, and only that: the bar
   * and the percentage read the negative state off `ratio` alone.
   */
  exhausted?: boolean;
  /** The strip's message. Falls back to the overall wording. */
  exhaustedMessage?: string;
  /** Opens the add-credits checkout. Omitted, the strip states its case only. */
  onAddCredits?: () => void;
  testId?: string;
  lineTestId?: string;
}

/** The cycle-end wording: the line under the title, and the bar's accessible name folding it in. */
export interface UsagePeriodEndLabels {
  line: string;
  barLabel: string;
}

/**
 * The cycle-end wording the reading and the tile's price row share, so the
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
 * The current-plan tile's footer, in place of the price row: one bordered
 * block holding every usage reading the tile charts, one row each. The rows
 * share a label column, so their bars start on the same line and run the
 * same length whatever each title measures.
 */
export function UsageBalancePanel({ children }: UsageBalancePanelProps) {
  return (
    // One surface step above the tile's base, so the panel reads as its own
    // block. Container query, not a viewport breakpoint: the tile is half a
    // card beside a next tile and the whole card without one, so the viewport
    // says nothing about the panel's width. The threshold is the content box,
    // about 514px of panel, above which the bars take a 64px gap after the
    // label column and stretch to the percentage. Below it the gap tightens
    // so the bars keep their length on phones.
    <div
      className="@container grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-[10px] border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3 @min-[30rem]:gap-x-16"
      data-testid="plan-usage-panel"
    >
      {children}
    </div>
  );
}

/**
 * One row of the panel: how much of a usage grant the account has already
 * used, over the date it turns over, with the add-credits strip beneath once
 * the grant is exhausted.
 */
export function UsageBalanceReading({
  ratio,
  title,
  periodEnd,
  line: lineOverride,
  barLabel: barLabelOverride,
  exhausted = false,
  exhaustedMessage,
  onAddCredits,
  testId = "plan-usage-balance",
  lineTestId = "plan-usage-period-end",
}: UsageBalanceReadingProps) {
  const { t } = useTranslation("settings");
  const periodEndLabels = usagePeriodEndLabels(periodEnd, t);
  const line = lineOverride ?? periodEndLabels?.line;
  // The bar's accessible name is one complete message per variant rather than
  // the title and the date line joined here: the joining punctuation is the
  // translator's, not ours.
  const barLabel = barLabelOverride ?? periodEndLabels?.barLabel ?? title;
  const pct = Math.round(ratio * 100);
  // Spending the whole bundle is the negative reading in its own right,
  // whatever the wallet behind it still holds.
  const spent = ratio >= 1;

  return (
    // Subgrid: the row lays its label and bar on the panel's two columns, so
    // every reading's bar starts where the widest label ends.
    <div
      data-testid={testId}
      className="col-span-2 grid grid-cols-subgrid items-center gap-y-3"
    >
      <div className="flex min-w-0 flex-col">
        <Typography
          as="span"
          variant="body-large-default"
          className="text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
        {line ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid={lineTestId}
          >
            {line}
          </Typography>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3">
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
      {exhausted ? (
        <div className="col-span-2 flex min-h-8 items-center justify-between gap-2 rounded-md bg-[var(--system-negative-weak)] px-2 py-1">
          <Typography
            as="span"
            variant="body-medium-default"
            className="min-w-0 text-[var(--system-negative-strong)]"
          >
            {exhaustedMessage ?? t("planCard.usageBalanceExhausted")}
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
