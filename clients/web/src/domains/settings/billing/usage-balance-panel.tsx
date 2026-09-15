import { Plus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";

export interface UsageBalancePanelProps {
  /** Used share of the granted usage credit, already clamped to 0..1. */
  ratio: number;
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
 * usage credit the account was granted it has already used.
 */
export function UsageBalancePanel({
  ratio,
  exhausted = false,
  onAddCredits,
}: UsageBalancePanelProps) {
  const { t } = useTranslation("settings");
  const title = t("planCard.usageBalanceTitle");
  const pct = Math.round(ratio * 100);
  // Spending the whole bundle is the negative reading in its own right,
  // whatever the wallet behind it still holds.
  const spent = ratio >= 1;

  return (
    // Transparent, so the panel sits on the tile's own surface instead of
    // laying a near-identical shade over it; the border alone groups it.
    <div
      data-testid="plan-usage-balance"
      className="flex w-full flex-col gap-2 rounded-[10px] border border-[var(--border-base)] px-4 py-3"
    >
      {/* Label and reading share the first row; the bar gets the next one to
          itself, so its length is the tile's width rather than whatever the
          label left over. */}
      <div className="flex w-full items-baseline justify-between gap-3">
        <Typography
          as="span"
          variant="body-large-default"
          className="min-w-0 text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
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
      <ProgressBar
        value={ratio}
        height={8}
        aria-label={title}
        fillColor={spent ? "var(--system-negative-strong)" : undefined}
        className="w-full rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
      />
      {exhausted ? (
        <div className="mt-1 flex min-h-8 w-full items-center justify-between gap-2 rounded-md bg-[var(--system-negative-weak)] px-2 py-1">
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
