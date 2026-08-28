import { Coins, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AddCreditsModal } from "@/components/add-credits-modal";
import { AutoTopUpCard } from "@/domains/settings/components/auto-top-up-card";
import {
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
  useOrganizationsBillingSummaryCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import { displayedCreditsUsd } from "@/lib/billing/displayed-credits";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { StatSquare } from "@vellumai/design-library/components/stat-square";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { useTranslation } from "@/i18n";
import { BillingSectionHeader } from "./billing-section-header";
import {
  DAILY_CREDIT_LIMIT_ANCHOR_ID,
  DailyCreditLimitCard,
} from "./daily-credit-limit-card";
import { LowBalanceAlertCard } from "./low-balance-alert-card";
import { ReferralModal } from "./referral-modal";

export const BOOTSTRAP_MAX_RETRIES = 3;
export const BOOTSTRAP_RETRY_DELAY_MS = 2000;

function formatCreditsShort(value: string): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "0";
  }
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return num < 0 ? `-${stripped}` : stripped;
}

export function BillingPanel() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const obscureCredits = useObscureCredits();

  const { data, isLoading, isError } = useQuery(
    organizationsBillingSummaryRetrieveOptions(),
  );

  const summary = data ?? null;

  const [addCreditsOpen, setAddCreditsOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [lowBalanceExpanded, setLowBalanceExpanded] = useState(false);

  const bootstrapAttemptsRef = useRef(0);
  const bootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bootstrapMutation = useOrganizationsBillingSummaryCreateMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveQueryKey(),
      });
    },
    onError: () => {
      if (bootstrapAttemptsRef.current < BOOTSTRAP_MAX_RETRIES) {
        bootstrapTimerRef.current = setTimeout(() => {
          bootstrapMutation.reset();
        }, BOOTSTRAP_RETRY_DELAY_MS);
      }
    },
  });

  useEffect(() => {
    return () => {
      if (bootstrapTimerRef.current) {
        clearTimeout(bootstrapTimerRef.current);
      }
    };
  }, []);

  const bootstrapMutate = bootstrapMutation.mutate;
  useEffect(() => {
    if (
      summary &&
      summary.settled_balance === "0.00" &&
      summary.pending_compute === "0.00" &&
      summary.effective_balance === "0.00" &&
      bootstrapAttemptsRef.current < BOOTSTRAP_MAX_RETRIES &&
      !bootstrapMutation.isPending &&
      !bootstrapMutation.isError &&
      !bootstrapMutation.isSuccess
    ) {
      bootstrapAttemptsRef.current += 1;
      bootstrapMutate({});
    }
  }, [
    summary,
    bootstrapMutation.isPending,
    bootstrapMutation.isError,
    bootstrapMutation.isSuccess,
    bootstrapMutate,
  ]);

  const creditsHeader = (
    <BillingSectionHeader
      title={t("billingPanel.title")}
      subtitle={t("billingPanel.subtitle")}
      actions={
        <>
          <Button
            variant="outlined"
            leftIcon={<Coins className="h-4 w-4" aria-hidden />}
            onClick={() => setReferralOpen(true)}
            data-testid="earn-credits-button"
          >
            {t("billingPanel.earnCreditsButton")}
          </Button>
          <Button
            variant="primary"
            onClick={() => setAddCreditsOpen(true)}
            disabled={isLoading || !summary}
            data-testid="add-credits-button"
          >
            {t("billingPanel.addCreditsButton")}
          </Button>
        </>
      }
    />
  );

  const renderBalanceBox = (): ReactNode => {
    if (!summary) {
      return null;
    }
    // Under the flag the tile names only the credit bought or earned on top
    // of the usage grants; the bar on the Plan tile measures those.
    const shown = displayedCreditsUsd(
      obscureCredits,
      summary.effective_balance,
      summary.available_usage_balance,
    );
    const effectiveNeg = parseFloat(shown) < 0;
    const formatted = formatCreditsShort(shown);
    const display = formatted.startsWith("-")
      ? `-$${formatted.slice(1)}`
      : `$${formatted}`;
    return (
      <div className="mt-4">
        <StatSquare
          icon={<Coins className="h-4 w-4" aria-hidden />}
          value={<span data-testid="effective-balance">{display}</span>}
          label={t("billingPanel.balanceLabel")}
          tone={effectiveNeg ? "negative" : "default"}
        />
      </div>
    );
  };

  const renderBalanceBody = (): ReactNode => {
    if (isLoading) {
      return (
        <div className="mt-4 flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("billingPanel.loading")}
        </div>
      );
    }
    if (isError) {
      return (
        <div className="mt-4">
          <Notice tone="error">{t("billingPanel.loadError")}</Notice>
        </div>
      );
    }
    if (!summary) {
      return (
        <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("billingPanel.noInfo")}
        </p>
      );
    }
    return (
      <>
        {renderBalanceBox()}
        {summary.is_degraded && (
          <div className="mt-4">
            <Notice tone="warning">{t("billingPanel.degradedNotice")}</Notice>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <Card padding="md">
        {creditsHeader}
        {renderBalanceBody()}
        <div className="mt-6">
          <AutoTopUpCard />
        </div>
        <div
          id={DAILY_CREDIT_LIMIT_ANCHOR_ID}
          className="mt-6 scroll-mt-4 border-t border-[var(--border-subtle)] pt-6"
        >
          <DailyCreditLimitCard />
        </div>
        <div className="mt-6 border-t border-[var(--border-subtle)] pt-6">
          <div className="flex flex-col gap-4">
            <Toggle
              checked={lowBalanceExpanded}
              onChange={setLowBalanceExpanded}
              label={t("billingPanel.lowBalanceToggle")}
            />
            {lowBalanceExpanded && <LowBalanceAlertCard />}
          </div>
        </div>
      </Card>

      <AddCreditsModal open={addCreditsOpen} onOpenChange={setAddCreditsOpen} />
      <ReferralModal open={referralOpen} onOpenChange={setReferralOpen} />
    </>
  );
}
