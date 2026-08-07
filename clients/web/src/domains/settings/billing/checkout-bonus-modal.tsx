import { Gift, Loader2 } from "lucide-react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingCheckoutBonusCreateMutation,
  organizationsBillingSummaryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

/** Format a USD decimal string ("5.00") as "$5", keeping non-zero cents ("$7.50"). */
function formatUsdShort(value: string): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) {
    return `$${value}`;
  }
  const formatted = n.toFixed(2);
  return `$${formatted.endsWith(".00") ? formatted.slice(0, -3) : formatted}`;
}

export interface CheckoutBonusModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Bonus amount as a USD decimal string (e.g. "5.00"), taken from the
   * eligibility response. The server owns the amount; nothing here assumes a
   * specific value.
   */
  amountUsd: string;
}

/**
 * Offer dialog for the one-time abandoned-checkout credit bonus. The parent
 * decides when to show it (server-verified eligibility); this component owns
 * the claim call. The server re-verifies on claim, so a stale offer resolves
 * to `already_claimed` / `ineligible` and the dialog bows out with an info
 * toast instead of granting.
 */
export function CheckoutBonusModal({
  open,
  onOpenChange,
  amountUsd,
}: CheckoutBonusModalProps) {
  const queryClient = useQueryClient();
  const claimMutation = useMutation(
    organizationsBillingCheckoutBonusCreateMutation(),
  );
  const pending = claimMutation.isPending;
  const amount = formatUsdShort(amountUsd);

  const handleClaim = () => {
    if (pending) {
      return;
    }
    claimMutation.mutate(
      {},
      {
        onSuccess: (data) => {
          if (data.status === "granted") {
            toast.success(
              `${formatUsdShort(data.amount_usd)} in credits added to your account.`,
            );
            void queryClient.invalidateQueries(
              organizationsBillingSummaryRetrieveOptions(),
            );
          } else {
            toast.info("This offer is no longer available.");
          }
          onOpenChange(false);
        },
        onError: () => {
          toast.error("Could not add the credits. Please try again.");
        },
      },
    );
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <Modal.Content size="sm" data-testid="checkout-bonus-modal">
        <Modal.Header>
          <Modal.Title icon={Gift}>Here&apos;s {amount} on us</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            Claim a one-time {amount} credit and we&apos;ll add it straight to
            your account balance. No payment required.
          </Typography>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined" disabled={pending}>
              No thanks
            </Button>
          </Modal.Close>
          <Button
            variant="primary"
            leftIcon={
              pending ? <Loader2 className="animate-spin" /> : undefined
            }
            onClick={handleClaim}
            disabled={pending}
            data-testid="claim-checkout-bonus-button"
          >
            Claim {amount} in credits
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
