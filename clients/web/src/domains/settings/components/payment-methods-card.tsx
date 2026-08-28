import { useEffect, useMemo, useState } from "react";

import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import type {
  CardOnFile,
  PaymentMethodModalMode,
} from "@/domains/settings/components/payment-method-modal-shell";
import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useSetupIntentReturn } from "@/domains/settings/hooks/use-setup-intent-return";
import { useAutoTopUpConfigQuery } from "@/hooks/use-auto-top-up-config";
import { useTranslation } from "@/i18n";

export interface PaymentMethodCardEntry {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
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
      // The config payload carries no expiry, so the card-on-file row in the
      // modal renders brand and last4 alone.
      expMonth: null,
      expYear: null,
    },
  ];
}

/**
 * What the modal was opened with. Captured on the click that opens it, because
 * a successful save writes the new card into the config query cache before the
 * modal closes: derived props would flip an in-flight add into replace mode and
 * swap the card-on-file row for the card that was just saved.
 */
interface PaymentModalSnapshot {
  mode: PaymentMethodModalMode;
  cardOnFile: CardOnFile | null;
}

function modalSnapshotFor(
  cards: PaymentMethodCardEntry[],
): PaymentModalSnapshot {
  const [existing] = cards;
  if (existing == null) {
    return { mode: "add", cardOnFile: null };
  }
  return {
    mode: "replace",
    cardOnFile: {
      brand: existing.brand,
      last4: existing.last4,
      expMonth: existing.expMonth,
      expYear: existing.expYear,
    },
  };
}

/**
 * Settings → Billing "Payment Methods" section. Card management lives here;
 * the auto-reload toggle and its config stay in `AutoTopUpCard` (Credits
 * section). The backend enforces a single payment method, so once a card is
 * on file the only offered action is replacing it (the same setup flow, opened
 * in `replace` mode); Add appears only while no card exists.
 */
export function PaymentMethodsCard() {
  const { t } = useTranslation("settings");
  const configQuery = useAutoTopUpConfigQuery();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  const { outcome, clearOutcome } = useSetupIntentReturn();

  const [pmModal, setPmModal] = useState<PaymentModalSnapshot | null>(null);

  const config = configQuery.data;
  const cards = useMemo(() => paymentMethodCards(config), [config]);
  const showAddButton = config != null && cards.length === 0;

  const openPaymentModal = () => {
    setPmModal(modalSnapshotFor(cards));
  };

  // A 3DS redirect return lands on a freshly loaded page, so the mode the save
  // was started in is gone: a saved outcome shows the success panel alone, and
  // a failed one reopens the form in the mode the saved card calls for.
  useEffect(() => {
    if (outcome == null) {
      return;
    }
    setPmModal((current) => {
      if (current != null) {
        return current;
      }
      return outcome.kind === "saved"
        ? { mode: "add", cardOnFile: null }
        : modalSnapshotFor(cards);
    });
  }, [outcome, cards]);

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
            onUpdateCard={openPaymentModal}
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
              onClick={openPaymentModal}
              data-testid="payment-methods-add"
            >
              {t("paymentMethodsCard.addButton")}
            </Button>
          ) : undefined
        }
      />

      {renderBody()}

      <AutoTopUpPaymentMethodModal
        open={pmModal != null}
        onClose={() => {
          setPmModal(null);
          clearOutcome();
        }}
        mode={pmModal?.mode ?? "add"}
        cardOnFile={pmModal?.cardOnFile ?? null}
        initialOutcome={outcome}
        onSavedOptimistic={syncPaymentMethodSaved}
      />
    </Card>
  );
}
