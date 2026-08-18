import { Gift, Loader2 } from "lucide-react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingCheckoutBonusCreateMutation,
  organizationsBillingCheckoutBonusRetrieveOptions,
  organizationsBillingSummaryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { formatUsdShort } from "@/utils/format-usd";

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
  const { t } = useTranslation("settings");
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
              t("checkoutBonusModal.grantedToast", {
                amount: formatUsdShort(data.amount_usd),
              }),
            );
            void queryClient.invalidateQueries(
              organizationsBillingSummaryRetrieveOptions(),
            );
          } else {
            toast.info(t("checkoutBonusModal.unavailableToast"));
          }
          // Every non-error result means the offer is spent (granted or
          // already claimed) or was never claimable (ineligible), so drop the
          // cached eligibility answer before closing: a stale `eligible: true`
          // would let the parent re-show the offer.
          void queryClient.invalidateQueries(
            organizationsBillingCheckoutBonusRetrieveOptions(),
          );
          onOpenChange(false);
        },
        onError: () => {
          toast.error(t("checkoutBonusModal.errorToast"));
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
        <Modal.Header icon={Gift}>
          <Modal.Title>
            {t("checkoutBonusModal.title", { amount })}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            {t("checkoutBonusModal.body", { amount })}
          </Typography>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined" disabled={pending}>
              {t("checkoutBonusModal.decline")}
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
            {t("checkoutBonusModal.claim", { amount })}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
