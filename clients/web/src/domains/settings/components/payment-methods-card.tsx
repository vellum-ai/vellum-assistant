import { useEffect, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import {
  modalSnapshotFor,
  paymentMethodCards,
  type PaymentModalSnapshot,
} from "@/domains/settings/utils/payment-method-cards";
import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useSetupIntentReturnStore } from "@/domains/settings/setup-intent-return-store";
import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { useAutoTopUpConfigQuery } from "@/hooks/use-auto-top-up-config";
import { useTranslation } from "@/i18n";
import { useRequestScopeKey } from "@/stores/request-scope";

/**
 * Settings → Billing "Payment Methods" section. Card management lives here;
 * the auto-reload toggle and its config stay in `AutoTopUpCard` (Credits
 * section). The backend enforces a single payment method, so once a card is
 * on file the only offered action is replacing it (the same setup flow, opened
 * in `replace` mode); Add appears only while no card exists.
 */
export function PaymentMethodsCard() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const configQuery = useAutoTopUpConfigQuery();
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  // A return that is still resolving keeps the Add and Replace actions
  // disabled: the modal replays that outcome as its `initialOutcome`, which is
  // seeded on open alone, so one opened in that window would never show it.
  // The return is driven from `BillingPage` and parked in the store, so it
  // survives this card being unmounted by a tab switch mid-resolution.
  const settledOutcome = useSetupIntentReturnStore.use.outcome();
  const settledScopeKey = useSetupIntentReturnStore.use.scopeKey();
  const returnPending = useSetupIntentReturnStore.use.pending();
  const clearOutcome = useSetupIntentReturnStore.use.clearOutcome();
  const scopeKey = useRequestScopeKey();

  // The store is module level, so it survives the user or organization switch
  // that remounts this card's QueryClient. An outcome settled under the scope
  // that was replaced is not this organization's answer: consuming it would
  // replay the previous organization's saved card and invalidate this one's
  // billing cache, so it is dropped instead.
  const outcomeInScope = settledOutcome != null && settledScopeKey === scopeKey;
  const outcome = outcomeInScope ? settledOutcome : null;

  const [pmModal, setPmModal] = useState<PaymentModalSnapshot | null>(null);

  useEffect(() => {
    if (settledOutcome != null && !outcomeInScope) {
      clearOutcome();
    }
  }, [settledOutcome, outcomeInScope, clearOutcome]);

  const config = configQuery.data;
  const cards = useMemo(() => paymentMethodCards(config), [config]);
  const showAddButton = config != null && cards.length === 0;

  const openPaymentModal = () => {
    setPmModal(modalSnapshotFor(cards));
  };

  // A 3DS redirect return lands on a freshly loaded page, so the mode the save
  // was started in is gone: a saved outcome shows the success panel alone, and
  // a failed one reopens the form in the mode the saved card calls for.
  //
  // That mode comes from the config query, so a failed outcome waits for it to
  // settle. Snapshotting while it is still pending would read no cards, and
  // the updater below preserves that snapshot: the replacement would replay
  // under the Add title with no card named in the subtitle for the rest of
  // the visit.
  const configSettled = configQuery.isSuccess || configQuery.isError;
  useEffect(() => {
    if (outcome == null) {
      return;
    }
    if (outcome.kind !== "saved" && !configSettled) {
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
  }, [outcome, cards, configSettled]);

  // The resolution confirmed the card through the QueryClient it captured when
  // it started, which a request-scope change can have discarded since. This
  // card's own client is the one the section renders from.
  //
  // A null card means the confirm failed and the poll timed out, so the cache
  // holds only the poll's deliberate optimistic flip, which a refetch wipes.
  useEffect(() => {
    if (outcome?.kind !== "saved" || outcome.card == null) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
    });
  }, [outcome, queryClient]);

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
            expMonth={card.expMonth}
            expYear={card.expYear}
            onUpdateCard={openPaymentModal}
            actionsDisabled={returnPending}
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
              disabled={returnPending}
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
        billingAddress={config?.billing_address ?? null}
        initialOutcome={outcome}
        onSavedOptimistic={syncPaymentMethodSaved}
      />
    </Card>
  );
}
