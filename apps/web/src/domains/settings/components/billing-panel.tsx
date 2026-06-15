import { Coins, DollarSign, Hourglass, Loader2 } from "lucide-react";
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
import { Typography } from "@vellumai/design-library/components/typography";

/** Maximum number of bootstrap retry attempts after transient failures. */
export const BOOTSTRAP_MAX_RETRIES = 3;

/** Delay in milliseconds between bootstrap retry attempts. */
export const BOOTSTRAP_RETRY_DELAY_MS = 2000;

/**
 * Format a decimal-string credit amount for balance display (no " credits" suffix).
 *
 * Returns a formatted string like "12" or "12.50" with comma grouping.
 * Whole-number amounts strip the trailing ".00". Used in balance sections
 * where the surrounding context already indicates credits.
 */
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

/**
 * BillingPanel shows the organization's credit balance with an inline
 * "Add Credits" button that launches the AddCreditsModal (Stripe Checkout).
 * The auto-reload section is embedded directly inside the same card under
 * a divider.
 */
export function BillingPanel() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery(
    organizationsBillingSummaryRetrieveOptions(),
  );

  const summary = data ?? null;

  const [addCreditsOpen, setAddCreditsOpen] = useState(false);

  // Bootstrap billing for pre-billing orgs that have no BillingAccount yet.
  // When the GET returns all-zero balances, fire the POST endpoint to create
  // the BillingAccount with the initial credit, then re-fetch.
  // Uses bounded retries so transient failures (network hiccups, 5xx) can
  // recover without looping forever.
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
          className="text-[var(--content-default)]"
        >
          Credit Balance
        </Typography>
        <Typography
          as="p"
          variant="body-small-default"
          className="mt-2 text-[var(--content-tertiary)]"
        >
          An overview of your credit balance and pending charges.
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

  const renderBalanceBoxes = (): ReactNode => {
    if (!summary) return null;
    const effectiveNeg = parseFloat(summary.effective_balance) < 0;
    const settledNeg = parseFloat(summary.settled_balance) < 0;
    const pendingNeg = parseFloat(summary.pending_compute) < 0;
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
        <StatSquare
          icon={<DollarSign className="h-4 w-4" aria-hidden />}
          value={
            <span data-testid="settled-balance">
              {formatCreditsShort(summary.settled_balance)}
            </span>
          }
          label="Settled Balance"
          tone={settledNeg ? "negative" : "default"}
        />
        <StatSquare
          icon={<Hourglass className="h-4 w-4" aria-hidden />}
          value={
            <span data-testid="pending-charges">
              {formatCreditsShort(summary.pending_compute)}
            </span>
          }
          label={
            summary.is_degraded ? "Pending Usage (estimated)" : "Pending Usage"
          }
          tone={
            summary.is_degraded
              ? "muted"
              : pendingNeg
                ? "negative"
                : "default"
          }
        />
      </div>
    );
  };

  // Render the balance section's body for the current summary state. The
  // outer Card always mounts (so the auto-reload section under it stays
  // accessible during a transient summary failure — it has its own
  // independent endpoint and shouldn't disappear with the balance row).
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
        <div className="mt-4">{renderBalanceBoxes()}</div>
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
        <div className="mt-6 border-t border-[var(--border-base)] pt-6">
          <AutoTopUpCard />
        </div>
      </Card>

      <AddCreditsModal open={addCreditsOpen} onOpenChange={setAddCreditsOpen} />
    </>
  );
}
