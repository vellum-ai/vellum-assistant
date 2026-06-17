
import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    organizationsBillingSummaryRetrieveOptions,
    organizationsBillingTopUpsCheckoutSessionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Modal } from "@vellumai/design-library/components/modal";

const DEFAULT_TOP_UP_AMOUNTS: [string, ...string[]] = [
  "10.00", "20.00", "30.00", "40.00", "50.00",
  "60.00", "70.00", "80.00", "90.00", "100.00",
];

function formatCredits(value: string): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "0 credits";
  }
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return `${stripped} credits`;
}

function extractCheckoutError(error: unknown): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const msgs = rec.amount;
    if (Array.isArray(msgs) && typeof msgs[0] === "string") {
      return msgs[0];
    }
  }
  return "Failed to create checkout session. Please try again.";
}

interface AddCreditsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddCreditsModal({ open, onOpenChange }: AddCreditsModalProps) {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const returnPath = searchParams.toString()
    ? `${pathname}?${searchParams.toString()}`
    : pathname;

  const { data: summary, isLoading } = useQuery(
    organizationsBillingSummaryRetrieveOptions(),
  );

  const topUpAmounts =
    summary?.allowed_top_up_amounts?.length
      ? summary.allowed_top_up_amounts
      : DEFAULT_TOP_UP_AMOUNTS;

  const [selectedAmount, setSelectedAmount] = useState<string | null>(null);
  const amount =
    selectedAmount && topUpAmounts.includes(selectedAmount)
      ? selectedAmount
      : topUpAmounts[0] ?? DEFAULT_TOP_UP_AMOUNTS[0];

  const checkoutMutation = useMutation(
    organizationsBillingTopUpsCheckoutSessionCreateMutation(),
  );

  // On native, SFSafariViewController stays on top of the app — the modal
  // remains mounted while Stripe checkout runs. When the user finishes (or
  // cancels), `browserFinished` fires: close the modal and refetch billing
  // summary so the balance reflects the completed top-up.
  useEffect(() => {
    return openUrlFinishedListener(() => {
      onOpenChange(false);
      void queryClient.invalidateQueries(
        organizationsBillingSummaryRetrieveOptions(),
      );
    });
  }, [onOpenChange, queryClient]);

  const handleAddFunds = () => {
    if (checkoutMutation.isPending) {
      return;
    }

    checkoutMutation.mutate(
      {
        body: {
          amount,
          return_path: returnPath,
        },
      },
      {
        onSuccess: (data) => {
          // On native (iOS), open in SFSafariViewController so the user stays
          // inside the app and Stripe's redirect back to return_path lands in
          // the in-app browser rather than breaking out to Safari.
          void openUrl(data.checkout_url);
        },
      },
    );
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title icon={CreditCard}>Add Credits</Modal.Title>
          <Modal.Description>
            Purchase credits to continue using the assistant. You&apos;ll be
            redirected to Stripe to complete the payment.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="add-credits-amount"
                className="block text-body-small-default text-[var(--content-tertiary)]"
              >
                Amount
              </label>
              <Dropdown
                id="add-credits-amount"
                value={amount}
                onChange={(value) => {
                  setSelectedAmount(value);
                  if (checkoutMutation.isError) {
                    checkoutMutation.reset();
                  }
                }}
                disabled={isLoading || !summary}
                options={topUpAmounts.map((val) => ({
                  value: val,
                  label: formatCredits(val),
                }))}
              />
            </div>

            {checkoutMutation.isError && (
              <div className="flex items-center gap-2 text-body-small-default text-[var(--system-negative-strong)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {extractCheckoutError(checkoutMutation.error)}
              </div>
            )}

            <Link
              to="/assistant/settings/billing"
              className="text-body-small-default text-[var(--content-tertiary)] underline hover:text-[var(--content-secondary)]"
              onClick={() => onOpenChange(false)}
            >
              Configure Automatic Top-Ups →
            </Link>
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined">Cancel</Button>
          </Modal.Close>
          <Button
            variant="primary"
            leftIcon={
              checkoutMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : undefined
            }
            onClick={handleAddFunds}
            disabled={checkoutMutation.isPending || isLoading || !summary}
          >
            Add credits
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
