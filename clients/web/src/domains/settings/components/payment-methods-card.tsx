import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingAutoTopUpRemovePaymentMethodCreateMutation,
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import { useTranslation } from "@/i18n";

export interface PaymentMethodCardEntry {
  id: string;
  brand: string | null;
  last4: string | null;
}

/**
 * The cards to list. The backend keeps at most one payment method and has no
 * list endpoint, so this is always length 0 or 1 today; the array is what the
 * multi-card rules below are written against.
 */
export function paymentMethodCards(
  config: AutoTopUpConfigResponse | undefined,
): PaymentMethodCardEntry[] {
  if (config == null || !config.has_payment_method) {
    return [];
  }
  return [
    {
      id: "primary",
      brand: config.payment_method_brand,
      last4: config.payment_method_last4,
    },
  ];
}

/**
 * Under `obscure-credits` a card may only be removed while another one would
 * remain, so the account is never left with no way to pay. With the flag off
 * every row keeps its Remove.
 */
export function showsRemove(
  cardCount: number,
  obscureCredits: boolean,
): boolean {
  return !obscureCredits || cardCount > 1;
}

/**
 * Settings → Billing "Payment Methods" section. Card management lives here;
 * the auto-reload toggle and its config stay in `AutoTopUpCard` (Credits
 * section), which reacts to removals via the shared config query.
 */
export function PaymentMethodsCard() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const configQuery = useQuery(organizationsBillingAutoTopUpRetrieveOptions());
  const removeMutation = useMutation(
    organizationsBillingAutoTopUpRemovePaymentMethodCreateMutation(),
  );
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  const obscureCredits = useObscureCredits();

  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const config = configQuery.data;

  /**
   * The remove endpoint clears the PM AND flips `enabled=False` server-side,
   * so the optimistic write lands on the disabled/no-PM state, matching what
   * the follow-up GET returns, with no separate disable call needed.
   * `AutoTopUpCard` closes its Adjust form via the `has_payment_method`
   * transition this write produces.
   */
  const handleConfirmRemove = () => {
    if (config == null) {
      return;
    }
    removeMutation.mutate(
      {},
      {
        onSuccess: () => {
          organizationsBillingAutoTopUpRetrieveSetQueryData(
            queryClient,
            undefined,
            {
              ...config,
              enabled: false,
              has_payment_method: false,
              payment_method_brand: null,
              payment_method_last4: null,
            },
          );
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
          });
          setConfirmingRemove(false);
        },
        // Close the dialog on failure so the error notice isn't hidden behind
        // the overlay; the card row stays put for a retry.
        onError: () => {
          setConfirmingRemove(false);
        },
      },
    );
  };

  const renderBody = () => {
    if (configQuery.isLoading) {
      return (
        <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("paymentMethodsCard.loading")}
        </p>
      );
    }
    if (configQuery.isError || config == null) {
      return (
        <div className="mt-4">
          <Notice tone="error">{t("paymentMethodsCard.loadError")}</Notice>
        </div>
      );
    }
    const cards = paymentMethodCards(config);
    if (cards.length === 0) {
      return (
        <div className="mt-4">
          <Notice tone="info" data-testid="payment-methods-empty">
            {t("paymentMethodsCard.empty")}
          </Notice>
        </div>
      );
    }
    const showRemove = showsRemove(cards.length, obscureCredits);
    return (
      <div className={cards.length > 1 ? "mt-4 flex flex-col gap-1" : "mt-4"}>
        {cards.map((card) => (
          <PaymentMethodRow
            key={card.id}
            brand={card.brand}
            last4={card.last4}
            onUpdateCard={() => setPmModalOpen(true)}
            onRemove={() => setConfirmingRemove(true)}
            removing={removeMutation.isPending}
            showRemove={showRemove}
          />
        ))}
      </div>
    );
  };

  return (
    <Card padding="md" data-testid="payment-methods-card">
      <BillingSectionHeader
        title={t("paymentMethodsCard.title")}
        subtitle={t("paymentMethodsCard.subtitle")}
        actions={
          <Button
            variant="outlined"
            onClick={() => setPmModalOpen(true)}
            data-testid="payment-methods-add"
          >
            {t("paymentMethodsCard.addButton")}
          </Button>
        }
      />

      {renderBody()}

      {removeMutation.isError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="auto-top-up-remove-error"
        >
          {t("paymentMethodsCard.removeError")}
        </Notice>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        title={t("paymentMethodsCard.removeConfirmTitle")}
        message={t("paymentMethodsCard.removeConfirmMessage")}
        confirmLabel={
          removeMutation.isPending
            ? t("paymentMethodsCard.removeConfirmPending")
            : t("paymentMethodsCard.removeConfirmConfirm")
        }
        isPending={removeMutation.isPending}
        cancelLabel={t("paymentMethodsCard.removeConfirmCancel")}
        destructive
        onConfirm={handleConfirmRemove}
        onCancel={() => setConfirmingRemove(false)}
      />

      <AutoTopUpPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onSavedOptimistic={syncPaymentMethodSaved}
      />
    </Card>
  );
}
