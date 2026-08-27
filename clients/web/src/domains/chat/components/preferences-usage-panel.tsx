import { Plus, Settings as SettingsIcon } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";
import { Typography } from "@vellumai/design-library/components/typography";

import { usePreferencesUsage } from "@/domains/chat/hooks/use-preferences-usage";
import { useTranslation } from "@/i18n";

export interface PreferencesUsagePanelProps {
  /** Opens the Billing tab of the usage settings page. */
  onOpenBilling: () => void;
  /** Opens the add-credits checkout. Omitted, the strip states its case only. */
  onAddCredits?: () => void;
  /** The chat the reading is for, which refines what counts as exhausted. */
  conversationId?: string | null;
}

/**
 * The preferences menu's usage reading while `obscure-credits` is on: the same
 * usage-balance reading the billing Plan tile draws, close to where the work
 * is being done. `usePreferencesUsage` decides whether there is anything
 * honest to say, and returns nothing when the flag is off, when the org has no
 * managed billing to read, or before a real number lands, so the menu is
 * otherwise exactly what it has always been.
 */
export function PreferencesUsagePanel({
  onOpenBilling,
  onAddCredits,
  conversationId,
}: PreferencesUsagePanelProps) {
  const { t } = useTranslation("chat");
  const usage = usePreferencesUsage({ conversationId });

  if (!usage) {
    return null;
  }

  const title = t("preferencesUsagePanel.title");
  const pct = Math.round(usage.ratio * 100);
  // Used-up grants with credit still behind them are not an alarm: the
  // percentage keeps its neutral color and the amber line below names the
  // extra usage credits in the bar's place. An empty wallet keeps the red
  // reading whether or not the BYOK-aware `exhausted` raises the strip below.
  const { spent, exhausted, usingExtraCredits } = usage;

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
                spent && !usingExtraCredits
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
        {usingExtraCredits ? (
          /* Body-small: at 14px the line would wrap inside the w-64 popover,
             and at 12px it still spans close to the bar's full width.
             `truncate` guards the longer locales against wrapping. */
          <Typography
            as="span"
            variant="body-small-default"
            className="w-full truncate text-[var(--system-mid-strong)]"
          >
            {t("preferencesUsagePanel.extraCredits")}
          </Typography>
        ) : (
          <ProgressBar
            value={usage.ratio}
            height={10}
            aria-label={title}
            fillColor={spent ? "var(--system-negative-strong)" : undefined}
            className="w-full rounded-full border border-[var(--border-base)] bg-[var(--surface-overlay)]"
          />
        )}
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
          {onAddCredits ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
