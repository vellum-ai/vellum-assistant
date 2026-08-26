import { Check, Coins, Copy, Loader2, Users } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useHoverCapable } from "@/hooks/use-hover-affordance";
import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tooltip } from "@vellumai/design-library/components/tooltip";
import { Typography } from "@vellumai/design-library/components/typography";

function stripDecimals(amount: string): string {
  return amount.replace(/\.00$/, "");
}

interface StatChipProps {
  icon: ReactNode;
  value: ReactNode;
  label: string;
}

function StatChip({ icon, value, label }: StatChipProps) {
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-base)] px-2 py-1.5">
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--content-default)]"
      >
        {icon}
      </span>
      <Typography
        variant="body-medium-default"
        as="span"
        className="text-[var(--content-default)]"
      >
        {value}
      </Typography>
      <Typography
        variant="body-small-default"
        as="span"
        className="min-w-0 truncate text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
    </div>
  );
}

export function ReferralContent() {
  const { t } = useTranslation("settings");
  const { data, isLoading, isError } = useQuery(
    referralCodesMeRetrieveOptions(),
  );

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (url: string) => {
      copyToClipboard(url, {
        successMessage: t("referralContent.copySuccess"),
        errorMessage: t("referralContent.copyError"),
        onCopied: () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        },
      });
    },
    [t],
  );

  const creditsGated = data?.is_eligible_for_credits === false;
  const hoverCapable = useHoverCapable();
  const gatedHintId = useId();

  const subtitle = data
    ? t("referralContent.subtitleWithAmounts", {
        creditAmount: stripDecimals(data.referrer_credit_amount),
        earningCap: stripDecimals(data.earning_cap),
      })
    : t("referralContent.subtitleDefault");

  const shareButton = data ? (
    <Button
      variant="outlined"
      // A natively disabled button swallows hover, so hover must land on
      // the tooltip's span trigger instead for the gated hint to open.
      className={cn("shrink-0", creditsGated && "pointer-events-none")}
      disabled={creditsGated}
      aria-describedby={creditsGated ? gatedHintId : undefined}
      onClick={() => handleCopy(data.referral_url)}
      leftIcon={
        copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )
      }
      data-testid="referral-copy-button"
    >
      {copied ? t("referralContent.copied") : t("referralContent.shareLink")}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-default"
        className="text-[var(--content-tertiary)]"
      >
        {subtitle}
      </Typography>

      {isLoading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("referralContent.loading")}
        </div>
      ) : isError || !data ? (
        <Notice tone="error">{t("referralContent.loadError")}</Notice>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-2">
            <StatChip
              icon={<Coins className="h-3.5 w-3.5" />}
              value={stripDecimals(data.total_earned)}
              label={t("referralContent.creditsEarned")}
            />
            <StatChip
              icon={<Users className="h-3.5 w-3.5" />}
              value={data.referred_count}
              label={t("referralContent.friendsReferred")}
            />
            {creditsGated ? (
              <Tooltip content={t("referralContent.gatedTooltip")}>
                {/* The disabled button cannot take focus, so where the
                    tooltip mounts the span is the tab stop that opens it
                    for sighted keyboard users. */}
                <span
                  tabIndex={hoverCapable ? 0 : undefined}
                  className="inline-flex shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  {shareButton}
                </span>
              </Tooltip>
            ) : (
              shareButton
            )}
          </div>
          {creditsGated && (
            // The tooltip only mounts where the device can hover, and the
            // disabled button cannot take focus, so this hint is the surface
            // touch and assistive-tech users reach: visible text on no-hover
            // devices, screen-reader-only where the tooltip covers hover.
            <Typography
              as="p"
              id={gatedHintId}
              variant="body-small-default"
              className={
                hoverCapable ? "sr-only" : "text-[var(--content-tertiary)]"
              }
            >
              {t("referralContent.gatedTooltip")}
            </Typography>
          )}
        </>
      )}
    </div>
  );
}
