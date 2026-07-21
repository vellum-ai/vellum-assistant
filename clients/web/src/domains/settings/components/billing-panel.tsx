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
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { StatSquare } from "@vellumai/design-library/components/stat-square";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";
import { DailyCreditLimitCard } from "./daily-credit-limit-card";
import { LowBalanceAlertCard } from "./low-balance-alert-card";

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
    const queryClient = useQueryClient();

    const { data, isLoading, isError } = useQuery(
        organizationsBillingSummaryRetrieveOptions(),
    );

    const summary = data ?? null;

    const [addCreditsOpen, setAddCreditsOpen] = useState(false);
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

    const creditBalanceHeader = (
        <div className="flex items-start justify-between gap-4">
            <div>
                <Typography
                    as="h2"
                    variant="title-medium"
                    className="text-[var(--content-emphasised)]"
                >
                    Credit Balance
                </Typography>
                <Typography
                    as="p"
                    variant="body-medium-default"
                    className="mt-2 text-[var(--content-tertiary)]"
                >
                    Quick overview of your balances and other things
                </Typography>
            </div>
            <Button
                variant="primary"
                onClick={() => setAddCreditsOpen(true)}
                disabled={isLoading || !summary}
                data-testid="add-credits-button"
            >
                Add Credits
            </Button>
        </div>
    );

    const renderBalanceBox = (): ReactNode => {
        if (!summary) return null;
        const effectiveNeg = parseFloat(summary.effective_balance) < 0;
        return (
            <div className="mt-4">
                <StatSquare
                    icon={<Coins className="h-4 w-4" aria-hidden />}
                    value={
                        <span data-testid="effective-balance">
                            {formatCreditsShort(summary.effective_balance)}
                        </span>
                    }
                    label="Balance"
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
                    Loading billing summary...
                </div>
            );
        }
        if (isError) {
            return (
                <div className="mt-4">
                    <Notice tone="error">
                        Failed to load billing summary. Please try again later.
                    </Notice>
                </div>
            );
        }
        if (!summary) {
            return (
                <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
                    No billing information available.
                </p>
            );
        }
        return (
            <>
                {renderBalanceBox()}
                {summary.is_degraded && (
                    <div className="mt-4">
                        <Notice tone="warning">
                            Pending charges could not be calculated. The balance shown may be incomplete.
                        </Notice>
                    </div>
                )}
            </>
        );
    };

    return (
        <>
            <Card padding="md">
                {creditBalanceHeader}
                {renderBalanceBody()}
                <div className="mt-6">
                    <div className="flex flex-col gap-4">
                        <Toggle
                            checked={lowBalanceExpanded}
                            onChange={setLowBalanceExpanded}
                            label="Custom low balance alert"
                        />
                        {lowBalanceExpanded && <LowBalanceAlertCard />}
                    </div>
                </div>
                <div className="mt-6 border-t border-[var(--border-base)] pt-6">
                    <AutoTopUpCard />
                </div>
                <div className="mt-6 border-t border-[var(--border-base)] pt-6">
                    <DailyCreditLimitCard />
                </div>
            </Card>

            <AddCreditsModal open={addCreditsOpen} onOpenChange={setAddCreditsOpen} />
        </>
    );
}
