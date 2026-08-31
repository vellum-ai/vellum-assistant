import { useEffect, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { ContentReveal } from "@/domains/settings/components/content-reveal";
import { SkeletonLines } from "@/domains/settings/components/skeleton-lines";
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
  // `isPending` rather than `isLoading`: the query idles with no data until
  // the org store is ready, and that gap must read as loading, not as the
  // error state.
  const configPending = configQuery.isPending;

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
  // under the Add title with no card-on-file row for the rest of the visit.
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

  // Contents of the always-mounted action slot below: a button-sized
  // placeholder while the config is pending, then the Add button or nothing.
  const renderHeaderAction = () => {
    if (configPending) {
      return (
        <Skeleton
          aria-hidden
          className="h-8 w-24 rounded-md"
          data-testid="payment-methods-add-skeleton"
        />
      );
    }
    if (!showAddButton) {
      return null;
    }
    return (
      <Button
        variant="outlined"
        onClick={openPaymentModal}
        disabled={returnPending}
        data-testid="payment-methods-add"
      >
        {t("paymentMethodsCard.addButton")}
      </Button>
    );
  };

  const renderBody = () => {
    if (configQuery.isError || config == null) {
      return <Notice tone="error">{t("paymentMethodsCard.loadError")}</Notice>;
    }
    if (cards.length === 0) {
      return (
        <Notice tone="info" data-testid="payment-methods-empty">
          {t("paymentMethodsCard.empty")}
        </Notice>
      );
    }
    return (
      <div className="flex flex-col gap-1">
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
          // The slot is mounted at button height for every outcome, because
          // while the config is pending we cannot know which one is coming:
          // a slot that appeared only when it had something to show would
          // take its whole row back out of the header (about 44px, stacked
          // below `sm`) as soon as a card-on-file config landed.
          <div
            className="flex h-8 items-center"
            data-testid="payment-methods-action-slot"
          >
            {renderHeaderAction()}
          </div>
        }
      />

      {configPending ? (
        // Presentational: the tab's own skeleton stack carries the label, so
        // a per-card status region would announce the same wait twice.
        <SkeletonLines
          lines={1}
          lineClassName="h-10 rounded-lg"
          className="mt-4"
        />
      ) : (
        <ContentReveal className="mt-4">{renderBody()}</ContentReveal>
      )}

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
