import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  organizationsBillingAutoTopUpRemovePaymentMethodCreateMutation,
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useTranslation } from "@/i18n";

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
    if (!config.has_payment_method) {
      return (
        <div className="mt-4">
          <Notice tone="info" data-testid="payment-methods-empty">
            {t("paymentMethodsCard.empty")}
          </Notice>
        </div>
      );
    }
    return (
      <div className="mt-4">
        <PaymentMethodRow
          brand={config.payment_method_brand}
          last4={config.payment_method_last4}
          onUpdateCard={() => setPmModalOpen(true)}
          onRemove={() => setConfirmingRemove(true)}
          removing={removeMutation.isPending}
        />
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
