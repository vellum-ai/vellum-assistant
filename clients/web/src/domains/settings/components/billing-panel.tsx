import { Coins } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AddCreditsModal } from "@/components/add-credits-modal";
import { ContentReveal } from "@/components/content-reveal";
import { AutoTopUpCard } from "@/domains/settings/components/auto-top-up-card";
import { BillingPanelBalanceSkeleton } from "@/domains/settings/components/billing-panel-balance-skeleton";
import { BillingPanelHeader } from "@/domains/settings/components/billing-panel-header";
import { BillingPanelRowGroup } from "@/domains/settings/components/billing-panel-row-group";
import {
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
  useOrganizationsBillingSummaryCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { displayedCreditsUsd } from "@/lib/billing/displayed-credits";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { StatSquare } from "@vellumai/design-library/components/stat-square";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { useTranslation } from "@/i18n";
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
    <BillingPanelHeader
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
    // The tile names only the credit bought or earned on top of the usage
    // grants; the bar on the Plan tile measures those.
    const shown = displayedCreditsUsd(
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
    // Only the balance swaps to a placeholder: the header, the nested cards and
    // the daily-limit anchor stay mounted, so those cards' own queries start
    // alongside this one instead of behind it.
    if (isLoading) {
      return (
        <BillingPanelBalanceSkeleton label={t("billingPanel.loadingLabel")} />
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
      <ContentReveal>
        {renderBalanceBox()}
        {summary.is_degraded && (
          <div className="mt-4">
            <Notice tone="warning">{t("billingPanel.degradedNotice")}</Notice>
          </div>
        )}
      </ContentReveal>
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
        <BillingPanelRowGroup
          id={DAILY_CREDIT_LIMIT_ANCHOR_ID}
          className="scroll-mt-4"
        >
          <DailyCreditLimitCard />
        </BillingPanelRowGroup>
        <BillingPanelRowGroup>
          <div className="flex flex-col gap-4">
            <Toggle
              checked={lowBalanceExpanded}
              onChange={setLowBalanceExpanded}
              label={t("billingPanel.lowBalanceToggle")}
            />
            {lowBalanceExpanded && <LowBalanceAlertCard />}
          </div>
        </BillingPanelRowGroup>
      </Card>

      <AddCreditsModal open={addCreditsOpen} onOpenChange={setAddCreditsOpen} />
      <ReferralModal open={referralOpen} onOpenChange={setReferralOpen} />
    </>
  );
}
