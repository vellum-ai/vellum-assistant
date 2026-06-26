import { Check, Coins, Copy, Loader2, Users } from "lucide-react";
import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

/** Anchor ID on the referral panel so external links can scroll to it. */
const REFERRAL_PANEL_ANCHOR_ID = "settings-referral-panel";

/** Strip a trailing `.00` from a decimal-string credit amount. */
function stripDecimals(amount: string): string {
  return amount.replace(/\.00$/, "");
}

/**
 * ReferralPanel — "Earn Free Credits" section on the billing settings tab.
 *
 * Surfaces the same data as the user/preferences-menu Earn Credits modal:
 * how many credits the user has earned, how many friends they've referred,
 * and a one-click way to copy their personal share link. The backend
 * lazily creates the referral code on first GET, so there's no explicit
 * creation step here.
 */
export function ReferralPanel() {
  const { data, isLoading, isError } = useQuery(
    referralCodesMeRetrieveOptions(),
  );

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      toast.success("Copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const creditsGated = data?.is_eligible_for_credits === false;

  const subtitle = creditsGated
    ? "Invite friends to Vellum. You'll start earning referral credits once you've purchased credits or upgraded to Pro."
    : data
      ? `Share Vellum with friends - you'll each earn ${stripDecimals(
          data.referrer_credit_amount,
        )} credits when they sign up, up to ${stripDecimals(
          data.earning_cap,
        )} total.`
      : "Share Vellum with friends and earn credits for every signup.";

  return (
    <Card padding="md" id={REFERRAL_PANEL_ANCHOR_ID}>
      <div className="flex flex-col gap-4">
        <div>
          <Typography
            as="h2"
            variant="title-medium"
            className="text-[var(--content-default)]"
          >
            Earn Free Credits
          </Typography>
          <Typography
            as="p"
            variant="body-small-default"
            className="mt-2 text-[var(--content-tertiary)]"
          >
            {subtitle}
          </Typography>
        </div>

        {creditsGated && (
          <Notice tone="info">
            You're not currently earning referral credits. Buy credits or
            upgrade to Pro to start earning — your invite link still works in
            the meantime.
          </Notice>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : isError || !data ? (
          <Notice tone="error">Failed to load referral information.</Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[200px] flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-base)] px-2 py-1.5">
              <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--content-emphasised)]">
                <Coins className="h-3.5 w-3.5" />
              </span>
              <span className="flex items-baseline gap-1 text-body-medium-default">
                <span>{stripDecimals(data.total_earned)}</span>
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  Credits Earned
                </span>
              </span>
            </div>
            <div className="flex min-w-[200px] flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-base)] px-2 py-1.5">
              <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--content-emphasised)]">
                <Users className="h-3.5 w-3.5" />
              </span>
              <span className="flex items-baseline gap-1 text-body-medium-default">
                <span>{data.referred_count}</span>
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  Friends Referred
                </span>
              </span>
            </div>
            <Button
              variant="outlined"
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
              {copied ? "Copied!" : "Copy Share Link"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
