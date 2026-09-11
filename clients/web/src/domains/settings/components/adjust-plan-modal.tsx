import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { captureTakeoverAvatarStash } from "@/lib/billing/takeover-avatar-stash";
import { proPackageDisplayName } from "@/domains/settings/billing/package-types";
import { currentPlanFeatures } from "@/domains/settings/billing/plan-spec";
import { useCancelSubscription } from "@/domains/settings/billing/use-cancel-subscription";
import { useReactivateSubscription } from "@/domains/settings/billing/use-reactivate-subscription";
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";
import { invalidateBillingQueries } from "@/domains/settings/billing/invalidate-billing-queries";
import { useChangeTiers } from "@/domains/settings/billing/use-change-tiers";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { useAndroidBillingHandoff } from "@/lib/billing/android-billing-handoff";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { useTranslation } from "@/i18n";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import {
  TIER_CHANGE_ELIGIBLE_STATUSES,
  extractMutationError,
  isDirectCancelEligible,
  resolveCreditTierSelection,
  resolveTierSelection,
} from "./adjust-plan-utils";
import { DowngradeReconfirmModal } from "./downgrade-reconfirm-modal";
import { PlanCardContent } from "./plan-card-content";

export interface AdjustPlanModalProps {
  open: boolean;
  onClose: () => void;
  onTierUpgraded?: () => void;
}

export function AdjustPlanModal(props: AdjustPlanModalProps) {
  // Native Android reopens this configurator on the web app (the
  // `adjust_plan` param seeds it there) instead of selling tiers in-app.
  const handsOff = useAndroidBillingHandoff({
    open: props.open,
    path: `${routes.settings.usageBilling}&adjust_plan`,
    onClose: props.onClose,
  });
  if (handsOff) {
    return null;
  }
  return <AdjustPlanModalContent {...props} />;
}

function AdjustPlanModalContent({
  open,
  onClose,
  onTierUpgraded,
}: AdjustPlanModalProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const plansQuery = useQuery(organizationsBillingPlansRetrieveOptions());
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const upgradeMutation = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const portalSnapshot = buildPortalReturnSnapshot(subscriptionQuery.data);
  // "Keep your Plan" posts the reactivate endpoint and the cancellation posts
  // the cancel endpoint; the portal is the fallback for subscriptions those
  // endpoints reject (non-entitlement status).
  const portalMutation = useBillingPortalSession(portalSnapshot);
  const { reactivateSubscription, isPending: reactivatePending } =
    useReactivateSubscription();
  const { cancelSubscription, isPending: cancelPending } =
    useCancelSubscription();
  const [view, setView] = useState<"plans" | "downgrade-confirm">("plans");
  const [tierDowngradeOpen, setTierDowngradeOpen] = useState(false);
  const [selectedMachineTier, setSelectedMachineTier] =
    useState<MachineTierEnum | null>(null);
  const [selectedStorageTier, setSelectedStorageTier] =
    useState<StorageTierEnum | null>(null);
  // `undefined` is the un-seeded sentinel (before the seeding effect runs);
  // `null` is the user's explicit "No bundle" choice.
  const [selectedCreditTier, setSelectedCreditTier] = useState<
    CreditTierEnum | null | undefined
  >(undefined);

  // On native (Capacitor iOS), Stripe Checkout / the billing portal opens in
  // SFSafariViewController as a popover on top of the app. When the user
  // finishes (or cancels), `browserFinished` fires while we're still mounted
  // with stale subscription data. Invalidate the relevant queries so the
  // surrounding UI re-fetches, then close the modal.
  useEffect(() => {
    return openUrlFinishedListener(() => {
      void invalidateBillingQueries(queryClient);
      onClose();
    });
  }, [queryClient, onClose]);

  const currentPlanId = subscriptionQuery.data?.plan_id;
  const onPro = currentPlanId === "pro";
  // The same submission path as the plans-page configurator: one
  // change-package call with explicit tiers, built against a fresh read.
  const {
    changeTiers,
    isPending: tierChangePending,
    error: tierChangeError,
    current: currentTiers,
  } = useChangeTiers({ enabled: onPro });

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: onPro,
  });
  const currentMachineTier =
    (onboardingQuery.data?.max_machine_tier as MachineTierEnum | null) ?? null;
  const currentStorageTier =
    (onboardingQuery.data?.selected_storage_tier as StorageTierEnum | null) ??
    null;
  const currentStorageGib = onboardingQuery.data?.selected_storage_gib ?? null;

  const cancelAtPeriodEnd =
    subscriptionQuery.data?.cancel_at_period_end === true ||
    Boolean(subscriptionQuery.data?.cancel_at);
  const isCanceled = subscriptionQuery.data?.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscriptionQuery.data);

  const subStatus = subscriptionQuery.data?.status;
  const tierChangeEligibleStatus =
    subStatus != null && TIER_CHANGE_ELIGIBLE_STATUSES.has(subStatus);

  const proTierChangeMode =
    onPro && tierChangeEligibleStatus && !cancelAtPeriodEnd && !isCanceled;

  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );

  const creditTiers = proPlan?.credit_tiers ?? [];
  const creditTiersEnabled = creditTiers.length > 0;

  const currentCreditTier =
    (subscriptionQuery.data?.selected_credit_tier as CreditTierEnum | null) ??
    null;
  const priceForCredit = (tier: CreditTierEnum | null): number =>
    creditTiers.find((t) => t.tier === tier)?.price_cents ?? 0;
  const currentCreditPriceCents = priceForCredit(currentCreditTier);
  const currentCreditPriceUnknown =
    currentCreditTier != null &&
    !creditTiers.some((t) => t.tier === currentCreditTier);

  const displayCreditTier: CreditTierEnum | null =
    selectedCreditTier === undefined ? currentCreditTier : selectedCreditTier;
  const selectedCreditPriceCents = priceForCredit(displayCreditTier);

  // The Pro card names the sub's real plan and lists its real tiers, so it
  // agrees with the billing plan card whose Manage button opens this modal.
  const planDisplayName = proPackageDisplayName(subscriptionQuery.data?.package);
  // Rows come from the current tiers, not the picker selection: the card states
  // what the sub holds, while the picker and the price delta express a pending
  // change. Gated on `isSuccess` rather than a loading flag because the machine
  // and storage tiers live on the onboarding read: while it is pending OR after
  // it errors, every tier reads null, which is indistinguishable from a
  // machine-less package and would describe a paid sub as the small baseline.
  const planFeatures =
    onPro && onboardingQuery.isSuccess && proPlan
      ? currentPlanFeatures(
          {
            machineTier: currentMachineTier,
            storageTier: currentStorageTier,
            storageGib: currentStorageGib,
            creditTier: currentCreditTier,
            hasPlatformFee: currentTiers.hasPlatformFee,
          },
          proPlan,
        )
      : null;

  // Disable storage tiers below current (downgrades not allowed).
  const machineTiersForPicker = proPlan?.machine_tiers ?? [];
  const storageTiersForPicker =
    proTierChangeMode && currentStorageGib != null
      ? (proPlan?.storage_tiers ?? []).map((t) =>
          t.storage_gib < currentStorageGib ? { ...t, disabled: true } : t,
        )
      : (proPlan?.storage_tiers ?? []);

  // Seed selections when the modal opens and the relevant data lands.
  useEffect(() => {
    if (!open) {
      setSelectedMachineTier(null);
      setSelectedStorageTier(null);
      setSelectedCreditTier(undefined);
      return;
    }
    if (!proPlan) {
      return;
    }
    if (proTierChangeMode) {
      if (currentMachineTier == null || currentStorageTier == null) {
        return;
      }
      setSelectedMachineTier((prev) =>
        resolveTierSelection<MachineTierEnum>(
          machineTiersForPicker,
          prev ?? currentMachineTier,
        ),
      );
      setSelectedStorageTier((prev) =>
        resolveTierSelection<StorageTierEnum>(
          storageTiersForPicker,
          prev ?? currentStorageTier,
        ),
      );
      setSelectedCreditTier((prev) =>
        resolveCreditTierSelection(creditTiers, prev, currentCreditTier),
      );
      return;
    }
    setSelectedMachineTier((prev) =>
      resolveTierSelection<MachineTierEnum>(proPlan.machine_tiers, prev),
    );
    setSelectedStorageTier((prev) =>
      resolveTierSelection<StorageTierEnum>(proPlan.storage_tiers, prev),
    );
    setSelectedCreditTier((prev) =>
      resolveCreditTierSelection(creditTiers, prev, null),
    );
  }, [
    open,
    proPlan,
    proTierChangeMode,
    currentMachineTier,
    currentStorageTier,
    currentCreditTier,
  ]);

  const basePlan = plansQuery.data?.plans.find((p) => p.id === "base");
  const baseFeatureSet = new Set(basePlan?.included_features ?? []);
  const lostFeatures = (proPlan?.included_features ?? []).filter(
    (f) => !baseFeatureSet.has(f),
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleUpgrade = () => {
    if (upgradeMutation.isPending) {
      return;
    }
    if (!selectedMachineTier || !selectedStorageTier) {
      toast.error(t("adjustPlanModal.pickTiersError"), {
        id: "pro-upgrade-error",
      });
      return;
    }
    upgradeMutation.mutate(
      {
        body: {
          target_plan_id: "pro",
          confirm: true,
          machine_tier: selectedMachineTier,
          storage_tier: selectedStorageTier,
          credit_tier: displayCreditTier,
          return_target: checkoutReturnTarget(),
        },
      },
      {
        onSuccess: (data) => {
          if (data.checkout_url) {
            // Stash the selection so the post-checkout provisioning screen
            // can show the purchased upgrade before the webhook lands.
            saveCheckoutIntent({
              kind: "custom",
              machineTier: selectedMachineTier,
              storageTier: selectedStorageTier,
              creditTier: displayCreditTier,
            });
            captureTakeoverAvatarStash(queryClient);
            void openUrl(data.checkout_url);
            return;
          }
          if (data.status === "no_op") {
            toast.info(t("adjustPlanModal.alreadyOnPro"), { id: "pro-upgrade" });
            onClose();
            return;
          }
          toast.error(
            data.message ?? t("adjustPlanModal.upgradeFailed"),
            { id: "pro-upgrade-error" },
          );
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              t("adjustPlanModal.upgradeFailed"),
            ),
            { id: "pro-upgrade-error" },
          );
        },
      },
    );
  };

  // Success returns to the plans view, where the invalidated subscription
  // read now shows "Your plan ends on ..." and the Keep-plan CTA; failure
  // stays on the confirm step so the user can retry (the hook already
  // toasted).
  const handleConfirmDowngrade = async () => {
    if (cancelPending || portalMutation.isPending) {
      return;
    }
    // A Pro sub the cancel endpoint rejects (non-entitlement status) keeps
    // the Stripe portal handoff, which can still cancel it.
    if (!isDirectCancelEligible(subscriptionQuery.data)) {
      setView("plans");
      portalMutation.mutate({});
      return;
    }
    const result = await cancelSubscription();
    if (result) {
      setView("plans");
    }
  };

  const machineChanged =
    selectedMachineTier != null && selectedMachineTier !== currentMachineTier;
  const storageChanged =
    selectedStorageTier != null && selectedStorageTier !== currentStorageTier;
  const creditChanged =
    creditTiersEnabled &&
    selectedCreditTier !== undefined &&
    selectedCreditTier !== currentCreditTier;
  // A custom plan always carries the platform fee, so a fee-less (Mighty) sub
  // has a pending change even with every tier untouched: applying adds, and
  // bills, the fee.
  const feeAdded = proTierChangeMode && !currentTiers.hasPlatformFee;

  const priceForMachine = (tier: MachineTierEnum | null): number | null =>
    machineTiersForPicker.find((t) => t.tier === tier)?.price_cents ?? null;
  const priceForStorage = (tier: StorageTierEnum | null): number | null =>
    storageTiersForPicker.find((t) => t.tier === tier)?.price_cents ?? null;
  const nextMachinePrice = priceForMachine(selectedMachineTier);
  const nextStoragePrice = priceForStorage(selectedStorageTier);
  const currentMachinePrice = priceForMachine(currentMachineTier);
  const currentStoragePrice = priceForStorage(currentStorageTier);
  const isMachineDowngrade =
    machineChanged &&
    nextMachinePrice != null &&
    currentMachinePrice != null &&
    nextMachinePrice < currentMachinePrice;

  const submitTierChanges = () => {
    if (tierChangePending) {
      return;
    }
    if (!selectedMachineTier || !selectedStorageTier) {
      toast.error(t("adjustPlanModal.pickTiersError"), {
        id: "pro-tier-change-error",
      });
      return;
    }
    void changeTiers({
      machineTier: selectedMachineTier,
      storageTier: selectedStorageTier,
      creditTier: displayCreditTier,
    }).then((result) => {
      if (!result) {
        // The hook toasted and exposes the message for the inline notice.
        return;
      }
      if (result.needsResize && onTierUpgraded) {
        onClose();
        onTierUpgraded();
        return;
      }
      toast.success(
        result.creditChanged && !machineChanged && !storageChanged
          ? t("adjustPlanModal.creditBundleUpdated")
          : t("adjustPlanModal.planUpdated"),
        { id: "pro-tier-change" },
      );
    });
  };

  // When the machine tier is being lowered, defer the whole apply behind the
  // reconfirm modal so the user confirms the smaller compute profile.
  const handleApplyTierChange = () => {
    if (tierChangePending) {
      return;
    }
    if (isMachineDowngrade) {
      setTierDowngradeOpen(true);
      return;
    }
    submitTierChanges();
  };

  const handleConfirmTierDowngrade = () => {
    setTierDowngradeOpen(false);
    submitTierChanges();
  };

  // ---------------------------------------------------------------------------
  // Derived display state for PlanCardContent
  // ---------------------------------------------------------------------------

  const proLiveTotalCents = (plan: ProPlan): number | null =>
    nextMachinePrice != null && nextStoragePrice != null
      ? plan.base_price_cents +
        nextMachinePrice +
        nextStoragePrice +
        selectedCreditPriceCents
      : null;

  // A fee-less sub's current total excludes the fee it is not yet billed for,
  // so the delta prices the fee the change adds.
  const proCurrentTotalCents = (plan: ProPlan): number | null =>
    currentMachinePrice != null && currentStoragePrice != null
      ? (feeAdded ? 0 : plan.base_price_cents) +
        currentMachinePrice +
        currentStoragePrice +
        currentCreditPriceCents
      : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isLoading = plansQuery.isLoading || subscriptionQuery.isLoading;
  const isError =
    plansQuery.isError ||
    subscriptionQuery.isError ||
    !plansQuery.data ||
    !subscriptionQuery.data;

  return (
    <>
      <Modal.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setView("plans");
            onClose();
          }
        }}
      >
        <Modal.Content size={view === "plans" ? "lg" : "md"}>
          {view === "downgrade-confirm" ? (
            <>
              <Modal.Header icon={AlertTriangle}>
                <Modal.Title>{t("adjustPlanModal.downgradeTitle")}</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                <Typography
                  as="p"
                  variant="body-medium-default"
                  className="text-(--content-secondary)"
                >
                  {t("adjustPlanModal.downgradeIntro")}
                </Typography>
                <ul className="mt-4 list-disc space-y-2 pl-5">
                  {lostFeatures.map((feature) => (
                    <li key={feature}>
                      <Typography as="span" variant="body-medium-default">
                        {feature}
                      </Typography>
                    </li>
                  ))}
                </ul>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="ghost"
                  onClick={() => setView("plans")}
                  disabled={cancelPending || portalMutation.isPending}
                  leftIcon={<ArrowLeft className="h-4 w-4" />}
                >
                  {t("adjustPlanModal.back")}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void handleConfirmDowngrade()}
                  disabled={cancelPending || portalMutation.isPending}
                  data-testid="confirm-downgrade-button"
                >
                  {t("adjustPlanModal.confirmDowngrade")}
                </Button>
              </Modal.Footer>
            </>
          ) : (
            <>
              <Modal.Header>
                <Modal.Title className="sr-only">{t("adjustPlanModal.upgradePlanTitle")}</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                {isLoading ? (
                  <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <Typography as="span" variant="body-medium-lighter">
                      {t("adjustPlanModal.loadingPlans")}
                    </Typography>
                  </div>
                ) : isError ? (
                  <Notice tone="error">
                    {t("adjustPlanModal.loadPlansError")}
                  </Notice>
                ) : (
                  <div className="space-y-4 sm:space-y-6">
                    <div className="space-y-2 pb-2 pt-4 text-center">
                      <Typography as="p" variant="title-medium">
                        {t("adjustPlanModal.heroTitle")}
                      </Typography>
                      <Typography
                        as="p"
                        variant="body-medium-lighter"
                        className="text-[var(--content-secondary)]"
                      >
                        {t("adjustPlanModal.heroSubtitle")}
                      </Typography>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {plansQuery.data!.plans.map((plan) => {
                        const planIsCurrent = plan.id === currentPlanId;
                        const liveTotalCents =
                          plan.id === "pro" && proPlan
                            ? proLiveTotalCents(proPlan)
                            : null;
                        const currentTotalCents =
                          plan.id === "pro" && proPlan
                            ? proCurrentTotalCents(proPlan)
                            : null;
                        const totalDelta =
                          liveTotalCents != null && currentTotalCents != null
                            ? liveTotalCents - currentTotalCents
                            : null;
                        return (
                          <PlanCardContent
                            key={plan.id}
                            plan={plan}
                            isCurrent={planIsCurrent}
                            onPro={onPro}
                            planDisplayName={planDisplayName}
                            currentPlanFeatures={planFeatures}
                            cancelAtPeriodEnd={cancelAtPeriodEnd}
                            isCanceled={isCanceled}
                            cancelDate={cancelDate}
                            formatGraceDate={formatGraceDate}
                            proTierChangeMode={proTierChangeMode}
                            creditTiersEnabled={creditTiersEnabled}
                            creditTiers={creditTiers}
                            displayCreditTier={displayCreditTier}
                            onCreditTierChange={setSelectedCreditTier}
                            selectedMachineTier={selectedMachineTier}
                            selectedStorageTier={selectedStorageTier}
                            onMachineTierChange={setSelectedMachineTier}
                            onStorageTierChange={setSelectedStorageTier}
                            machineTiersForPicker={machineTiersForPicker}
                            storageTiersForPicker={storageTiersForPicker}
                            currentMachinePrice={currentMachinePrice}
                            currentStoragePrice={currentStoragePrice}
                            currentCreditPriceUnknown={
                              currentCreditPriceUnknown
                            }
                            proCurrentTotalCents={currentTotalCents}
                            proLiveTotalCents={liveTotalCents}
                            proTotalDelta={totalDelta}
                            onboardingLoading={onboardingQuery.isLoading}
                            tierChangePending={tierChangePending}
                            machineChanged={machineChanged}
                            storageChanged={storageChanged}
                            creditChanged={creditChanged}
                            feeAdded={feeAdded}
                            tierChangeError={tierChangeError}
                            upgradePending={upgradeMutation.isPending}
                            billingActionPending={
                              portalMutation.isPending || reactivatePending
                            }
                            onUpgrade={handleUpgrade}
                            onApplyTierChange={handleApplyTierChange}
                            onDowngradeClick={() =>
                              setView("downgrade-confirm")
                            }
                            onKeepPlan={() => {
                              if (
                                !isDirectCancelEligible(subscriptionQuery.data)
                              ) {
                                portalMutation.mutate({});
                                return;
                              }
                              void reactivateSubscription();
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </Modal.Body>
              <Modal.Footer className="relative items-center">
                <Typography
                  as="p"
                  variant="body-small-default"
                  className="pointer-events-none absolute inset-x-0 text-center text-[var(--content-tertiary)]"
                >
                  <span className="pointer-events-auto">
                    {t("adjustPlanModal.footerNote")}
                  </span>
                </Typography>
                <div className="ml-auto">
                  <Button
                    variant="outlined"
                    onClick={onClose}
                    data-testid="modal-cancel-button"
                  >
                    {t("adjustPlanModal.cancel")}
                  </Button>
                </div>
              </Modal.Footer>
            </>
          )}
        </Modal.Content>
      </Modal.Root>
      <DowngradeReconfirmModal
        open={tierDowngradeOpen}
        onCancel={() => setTierDowngradeOpen(false)}
        onConfirm={handleConfirmTierDowngrade}
        confirming={tierChangePending}
        lostFeatures={[
          t("adjustPlanModal.machineDowngradeFeature"),
        ]}
      />
    </>
  );
}
