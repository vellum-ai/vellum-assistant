import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { useMutation, useQuery } from "@tanstack/react-query";

import {
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingTopUpsCheckoutSessionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { ANDROID_BILLING_MESSAGE } from "@/lib/billing/android-consumption-only";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";

const DEFAULT_TOP_UP_AMOUNTS: [string, ...string[]] = [
  "10.00",
  "20.00",
  "30.00",
  "40.00",
  "50.00",
  "60.00",
  "70.00",
  "80.00",
  "90.00",
  "100.00",
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

function AddCreditsModalContent({ open, onOpenChange }: AddCreditsModalProps) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const returnPath = searchParams.toString()
    ? `${pathname}?${searchParams.toString()}`
    : pathname;

  const { data: summary, isLoading } = useQuery(
    organizationsBillingSummaryRetrieveOptions(),
  );

  const topUpAmounts = summary?.allowed_top_up_amounts?.length
    ? summary.allowed_top_up_amounts
    : DEFAULT_TOP_UP_AMOUNTS;

  const [selectedAmount, setSelectedAmount] = useState<string | null>(null);
  const amount =
    selectedAmount && topUpAmounts.includes(selectedAmount)
      ? selectedAmount
      : (topUpAmounts[0] ?? DEFAULT_TOP_UP_AMOUNTS[0]);

  const checkoutMutation = useMutation(
    organizationsBillingTopUpsCheckoutSessionCreateMutation(),
  );

  // On native, SFSafariViewController stays on top of the app: the modal
  // remains mounted while Stripe checkout runs. `browserFinished` fires when
  // the sheet closes for any reason, so it carries no success/cancel meaning
  // and only closes the modal. Every completed outcome (and its
  // billing-summary refetch) arrives separately via the `flow=top_up`
  // checkout-complete deep link; a sheet dismissed with no outcome has
  // nothing to refetch.
  useEffect(() => {
    return openUrlFinishedListener(() => {
      onOpenChange(false);
    });
  }, [onOpenChange]);

  // The outcome-carrying return: the `flow=top_up` checkout-complete deep
  // link. On Electron this is the ONLY return signal (`browserFinished`
  // above is Capacitor-only, and Stripe runs in the system browser), so
  // without it the stale modal would sit over the success toast or the
  // billing page's cancel-triggered bonus-offer flow, its Continue button
  // still armed to start a second checkout. This subscription only closes
  // the modal, on either outcome; all outcome handling (success toast plus
  // the billing-summary invalidation) is owned by
  // `useGlobalDeepLinkConsumer` via `notifyCheckoutSuccess`.
  useBusSubscription("deeplink.billingCheckoutComplete", ({ flow }) => {
    if (flow !== "top_up") {
      return;
    }
    onOpenChange(false);
  });

  const handleAddFunds = () => {
    if (checkoutMutation.isPending) {
      return;
    }

    checkoutMutation.mutate(
      {
        body: {
          amount,
          // Ignored when return_target is "native".
          return_path: returnPath,
          // On Capacitor/Electron, checkout finishes with a custom-scheme
          // bounce back into the app (`<scheme>://billing/checkout-complete`
          // carrying `flow=top_up`) instead of a web return URL; see
          // `checkout-return-target.ts`.
          return_target: checkoutReturnTarget(),
        },
      },
      {
        onSuccess: (data) => {
          // On native (iOS), open in SFSafariViewController so the user stays
          // inside the app; the native return's custom-scheme bounce dismisses
          // the sheet and lands back in the app via `appUrlOpen`.
          void openUrl(data.checkout_url);
        },
      },
    );
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Add Credits</Modal.Title>
          <Modal.Description>
            You&apos;ll be redirected to Stripe to complete the payment.
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
              <Select
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
              to={routes.settings.usageBillingConfigureTopUps}
              className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
              onClick={() => onOpenChange(false)}
            >
              Configure Automatic Top-Ups
              <ChevronRight className="size-4" />
            </Link>

            <div className="h-px w-full bg-[var(--border-subtle)]" />
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
            Continue
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export function AddCreditsModal(props: AddCreditsModalProps) {
  const isNativeAndroid = useIsNativeAndroid();

  if (!isNativeAndroid) {
    return <AddCreditsModalContent {...props} />;
  }

  return (
    <Modal.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Billing</Modal.Title>
          <Modal.Description>{ANDROID_BILLING_MESSAGE}</Modal.Description>
        </Modal.Header>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined">Close</Button>
          </Modal.Close>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
