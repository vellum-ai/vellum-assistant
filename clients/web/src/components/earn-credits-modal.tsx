import {
    ArrowLeft,
    Check,
    Copy,
    CreditCard,
    Gift,
    Loader2,
    Share2,
    Users,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button, Input, Modal } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";

import { referralCodesMeRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";

interface EarnCreditsModalProps {
  open: boolean;
  onClose: () => void;
}

function stripDecimals(amount: string): string {
  return amount.replace(/\.00$/, "");
}

function buildSubtitle(
  referrerCreditAmount: string,
  creditAmount: string,
  earningCap: string,
): string {
  const cap = stripDecimals(earningCap);
  const referrerAmount = stripDecimals(referrerCreditAmount);
  const refereeAmount = stripDecimals(creditAmount);
  if (referrerAmount === refereeAmount) {
    return `Share Vellum with friends — you'll each earn ${referrerAmount} credits when they sign up, up to ${cap} total.`;
  }
  return `Share Vellum with friends — you'll earn ${referrerAmount} credits and they'll get ${refereeAmount} when they sign up, up to ${cap} total.`;
}

export function EarnCreditsModal({ open, onClose }: EarnCreditsModalProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? <EarnCreditsModalInner /> : null}
    </Modal.Root>
  );
}

function EarnCreditsModalInner() {
  const [copied, setCopied] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery(
    referralCodesMeRetrieveOptions(),
  );

  const handleCopy = useCallback((url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const creditsGated = data?.is_eligible_for_credits === false;

  const subtitle = !data
    ? "Refer friends to earn free credits."
    : creditsGated
      ? "Invite friends to Vellum. You'll start earning referral credits once you've purchased credits or upgraded to Pro."
      : buildSubtitle(
          data.referrer_credit_amount,
          data.credit_amount,
          data.earning_cap,
        );

  const cap = data ? stripDecimals(data.earning_cap) : "";
  const title = showTerms ? "Referral Program Terms" : "Earn free credits";

  return (
    <Modal.Content size="sm">
      <Modal.Header>
        <div className="flex min-w-0 items-start gap-2">
          {showTerms && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<ArrowLeft />}
              onClick={() => setShowTerms(false)}
              aria-label="Back"
              className="mt-0.5"
              tintColor="var(--content-secondary)"
            />
          )}
          <div className="min-w-0">
            <Modal.Title>{title}</Modal.Title>
            {!showTerms && <Modal.Description>{subtitle}</Modal.Description>}
          </div>
        </div>
      </Modal.Header>
      <Modal.Body>
        {showTerms && data ? (
          <TermsContent cap={cap} />
        ) : isLoading ? (
          <div
            className="flex items-center gap-2 py-2 text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading referral information…
          </div>
        ) : isError || !data ? (
          <div className="space-y-3">
            <p
              className="!m-0 text-body-medium-lighter"
              style={{ color: "var(--content-secondary)" }}
            >
              Failed to load referral information.
            </p>
            <Button
              variant="outlined"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? "Retrying…" : "Try Again"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <HowItWorksStep
                icon={<Share2 className="h-4 w-4" />}
                label="Share your invite link"
              />
              <HowItWorksStep
                icon={<Users className="h-4 w-4" />}
                label="They sign up"
              />
              <HowItWorksStep
                icon={<Gift className="h-4 w-4" />}
                label={
                  creditsGated
                    ? "You earn credits — once you've purchased credits or upgraded to Pro"
                    : "You earn credits"
                }
              />
            </div>

            <div style={{ borderTop: "1px solid var(--border-base)" }} />

            {creditsGated && (
              <Notice tone="info">
                You're not currently earning referral credits. Buy credits or
                upgrade to Pro to start earning — your invite link still works
                in the meantime.
              </Notice>
            )}

            <div className="flex items-center gap-2">
              <Input
                type="text"
                readOnly
                value={data.referral_url}
                fullWidth
                wrapperClassName="flex-1"
                className="font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outlined"
                iconOnly={copied ? <Check /> : <Copy />}
                onClick={() => handleCopy(data.referral_url)}
                aria-label="Copy referral link"
                className="h-9 w-9"
              />
            </div>

            <div style={{ borderTop: "1px solid var(--border-base)" }} />

            <div className="flex items-center justify-between gap-4">
              <StatItem
                icon={<Users className="h-3.5 w-3.5" />}
                value={String(data.referred_count)}
                label="Friends Referred"
              />
              <StatItem
                icon={<CreditCard className="h-3.5 w-3.5" />}
                value={stripDecimals(data.total_earned)}
                label="Credits Earned"
              />
            </div>

            <div style={{ borderTop: "1px solid var(--border-base)" }} />

            <Button
              variant="ghost"
              size="compact"
              onClick={() => setShowTerms(true)}
              fullWidth
              className="text-body-small-default"
              tintColor="var(--content-tertiary)"
            >
              View Terms and Conditions
            </Button>
          </div>
        )}
      </Modal.Body>
    </Modal.Content>
  );
}

function HowItWorksStep({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{
          background: "var(--surface-base)",
          color: "var(--content-secondary)",
        }}
      >
        {icon}
      </div>
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {label}
      </span>
    </div>
  );
}

function StatItem({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-body-medium-lighter">
      <span style={{ color: "var(--content-tertiary)" }}>{icon}</span>
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {value}
      </span>
      <span style={{ color: "var(--content-tertiary)" }}>{label}</span>
    </div>
  );
}

function TermsContent({ cap }: { cap: string }) {
  const bullets = [
    "This promotion is available to new users who sign up through your referral link only.",
    "Rewards are earned once your invitee completes the creation of their Vellum account.",
    `You may earn up to ${cap} free credits through the Referral Program. We may change this limit at any time.`,
    "We do not grant credits for disposable or high-risk email accounts.",
    "Each new user can generate only one (1) reward. No stacking or loophole hunting.",
    "Please avoid spamming or misusing your referral link. Our systems actively monitor referral engagement.",
    "If we detect suspicious or non-compliant activity, we reserve the right to withhold rewards or deactivate your referral link.",
    "We may update, pause, or discontinue this program at any time.",
  ];

  return (
    <ul className="!m-0 !list-none space-y-2 !p-0">
      {bullets.map((text) => (
        <li
          key={text}
          className="flex items-start gap-2 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          <span aria-hidden="true" className="mt-0.5">
            •
          </span>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}
