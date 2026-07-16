import { Check, Coins, Copy, ExternalLink, Loader2, Users } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { openUrl } from "@/runtime/browser";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

const REFERRAL_PANEL_ANCHOR_ID = "settings-referral-panel";

function stripDecimals(amount: string): string {
  return amount.replace(/\.00$/, "");
}

interface StatPillProps {
  icon: ReactNode;
  value: ReactNode;
  label: string;
}

function StatPill({ icon, value, label }: StatPillProps) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-base)] px-3 py-2">
        <span
          aria-hidden="true"
          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--content-tertiary)]"
        >
          {icon}
        </span>
        <Typography variant="body-medium-default" as="span" className="text-[var(--content-default)]">
          {value}
        </Typography>
        <Typography variant="body-small-default" as="span" className="text-[var(--content-tertiary)]">
          {label}
        </Typography>
      </div>
    );
}

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
        <div className="flex flex-col gap-3">
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
              variant="body-medium-default"
              className="mt-2 text-[var(--content-tertiary)]"
            >
              {subtitle}
            </Typography>
          </div>

          {creditsGated && (
            <Typography
              as="p"
              variant="body-medium-default"
              className="text-[var(--content-tertiary)]"
            >
              You're not currently earning referral credits. Buy credits or
              upgrade to Pro to start earning — your invite link still works in
              the meantime.
            </Typography>
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
              <StatPill
                icon={<Coins className="h-3.5 w-3.5" />}
                value={stripDecimals(data.total_earned)}
                label="Credits Earned"
              />
              <StatPill
                icon={<Users className="h-3.5 w-3.5" />}
                value={data.referred_count}
                label="Friends Referred"
              />
            </div>
          )}

          {data && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={() => openUrl(data.referral_url)}
                data-testid="referral-view-button"
              >
                View Referrals
              </Button>
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
