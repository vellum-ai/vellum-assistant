import { Check, Coins, Copy, Loader2, Users } from "lucide-react";
import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { SkillRow } from "@vellum/design-library/components/skill-row";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";

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

  const subtitle = data
    ? `Share Vellum with Friends - you'll each earn ${stripDecimals(
        data.referrer_credit_amount,
      )} credits when they sign up, up to ${stripDecimals(
        data.earning_cap,
      )} total.`
    : "Share Vellum with Friends and earn credits for every signup.";

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

        {isLoading ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : isError || !data ? (
          <Notice tone="error">Failed to load referral information.</Notice>
        ) : (
          <div className="flex flex-wrap items-stretch gap-2">
            <div className="min-w-[200px] flex-1">
              <SkillRow
                icon={<Coins className="h-3.5 w-3.5" aria-hidden />}
                title={
                  <span className="flex items-baseline gap-1">
                    <span>{stripDecimals(data.total_earned)}</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Credits Earned
                    </span>
                  </span>
                }
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <SkillRow
                icon={<Users className="h-3.5 w-3.5" aria-hidden />}
                title={
                  <span className="flex items-baseline gap-1">
                    <span>{data.referred_count}</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Friends Referred
                    </span>
                  </span>
                }
              />
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
