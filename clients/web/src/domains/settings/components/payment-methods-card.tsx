import { useState } from "react";

import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useAutoTopUpConfigQuery } from "@/hooks/use-auto-top-up-config";
import { useTranslation } from "@/i18n";

export interface PaymentMethodCardEntry {
  id: string;
  brand: string | null;
  last4: string | null;
}

/**
 * The cards to list. The backend keeps at most one payment method and has no
 * list endpoint, so this is always length 0 or 1 today; the array is what the
 * multi-card render below is written against.
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
 * Settings → Billing "Payment Methods" section. Card management lives here;
 * the auto-reload toggle and its config stay in `AutoTopUpCard` (Credits
 * section). The backend enforces a single payment method, so once a card is
 * on file the only offered action is updating it (which replaces the card
 * via the same setup flow); Add appears only while no card exists.
 */
export function PaymentMethodsCard() {
  const { t } = useTranslation("settings");
  const configQuery = useAutoTopUpConfigQuery();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();

  const [pmModalOpen, setPmModalOpen] = useState(false);

  const config = configQuery.data;
  const cards = paymentMethodCards(config);
  const showAddButton = config != null && cards.length === 0;

  const renderBody = () => {
    // `isPending` rather than `isLoading`: the query idles with no data until
    // the org store is ready, and that gap must read as loading, not as the
    // error state below.
    if (configQuery.isPending) {
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
    if (cards.length === 0) {
      return (
        <div className="mt-4">
          <Notice tone="info" data-testid="payment-methods-empty">
            {t("paymentMethodsCard.empty")}
          </Notice>
        </div>
      );
    }
    return (
      <div className={cards.length > 1 ? "mt-4 flex flex-col gap-1" : "mt-4"}>
        {cards.map((card) => (
          <PaymentMethodRow
            key={card.id}
            brand={card.brand}
            last4={card.last4}
            onUpdateCard={() => setPmModalOpen(true)}
          />
        ))}
      </div>
    );
  };

  return (
    <Card padding="md" data-testid="payment-methods-card">
      <BillingSectionHeader
        title={t("paymentMethodsCard.title")}
        actions={
          showAddButton ? (
            <Button
              variant="outlined"
              onClick={() => setPmModalOpen(true)}
              data-testid="payment-methods-add"
            >
              {t("paymentMethodsCard.addButton")}
            </Button>
          ) : undefined
        }
      />

      {renderBody()}

      <AutoTopUpPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onSavedOptimistic={syncPaymentMethodSaved}
      />
    </Card>
  );
}
