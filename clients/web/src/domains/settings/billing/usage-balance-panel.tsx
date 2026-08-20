import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";

export interface UsageBalancePanelProps {
  /** Spend against the included bundle, already clamped to 0..1. */
  ratio: number;
  /** ISO timestamp the current billing cycle ends on. */
  resetsAt: string;
}

/**
 * The current-plan tile's footer while `obscure-credits` is on: how much of the
 * package's included usage this cycle has spent, in place of the price row.
 */
export function UsageBalancePanel({ ratio, resetsAt }: UsageBalancePanelProps) {
  const { t, i18n } = useTranslation("settings");
  const title = t("planCard.usageBalanceTitle");
  const pct = Math.round(ratio * 100);
  const resetDate = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
  }).format(new Date(resetsAt));

  return (
    <div
      data-testid="plan-usage-balance"
      className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--border-base)] bg-[color-mix(in_srgb,var(--surface-overlay)_40%,transparent)] px-4 py-3"
    >
      <div className="flex min-w-0 flex-col">
        <Typography
          as="span"
          variant="body-large-default"
          className="text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {t("planCard.usageBalanceResets", { date: resetDate })}
        </Typography>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        <ProgressBar
          value={ratio}
          height={8}
          aria-label={title}
          className="w-full min-w-0 max-w-[249px] rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
        />
        <Typography
          as="span"
          variant="body-small-default"
          className="whitespace-nowrap text-[var(--content-secondary)]"
        >
          {t("planCard.usageBalancePctUsed", { pct })}
        </Typography>
      </div>
    </div>
  );
}
