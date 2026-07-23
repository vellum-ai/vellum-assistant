import { Check, Coins, Copy, Loader2, Users } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
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
        className="text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
    </div>
  );
}

export function ReferralContent() {
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Typography
          as="h2"
          variant="title-medium"
          className="text-[var(--content-emphasised)]"
        >
          Earn Free Credits
        </Typography>
        <Typography
          as="p"
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
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
          You're not currently earning referral credits. Buy credits or upgrade
          to Pro to start earning — your invite link still works in the
          meantime.
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
        <div className="flex flex-wrap items-start gap-2">
          <StatChip
            icon={<Coins className="h-3.5 w-3.5" />}
            value={stripDecimals(data.total_earned)}
            label="Credits Earned"
          />
          <StatChip
            icon={<Users className="h-3.5 w-3.5" />}
            value={data.referred_count}
            label="Friends Referred"
          />
          <Button
            variant="outlined"
            className="shrink-0"
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
  );
}
