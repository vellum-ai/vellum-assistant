import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { captureTakeoverAvatarStash } from "@/lib/billing/takeover-avatar-stash";
import { proPackageDisplayName } from "@/domains/settings/billing/package-types";
import { currentPlanFeatures } from "@/domains/settings/billing/plan-spec";
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionChangeCreditTierCreateMutation,
  organizationsBillingSubscriptionChangeMachineTierCreateMutation,
  organizationsBillingSubscriptionChangeStorageTierCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { useTranslation } from "@/i18n";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import {
  TIER_CHANGE_ELIGIBLE_STATUSES,
  extractMutationError,
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

export function AdjustPlanModal({
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
  const changeMachineTierMutation = useMutation(
    organizationsBillingSubscriptionChangeMachineTierCreateMutation(),
  );
  const changeStorageTierMutation = useMutation(
    organizationsBillingSubscriptionChangeStorageTierCreateMutation(),
  );
  const changeCreditTierMutation = useMutation(
    organizationsBillingSubscriptionChangeCreditTierCreateMutation(),
  );
  const portalSnapshot = buildPortalReturnSnapshot(subscriptionQuery.data);
  const portalMutation = useBillingPortalSession(portalSnapshot);
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
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingPlansRetrieveQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      });
      onClose();
    });
  }, [queryClient, onClose]);

  const currentPlanId = subscriptionQuery.data?.plan_id;
  const onPro = currentPlanId === "pro";

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

  const handleConfirmDowngrade = () => {
    if (portalMutation.isPending) {
      return;
    }
    setView("plans");
    portalMutation.mutate({});
  };

  const invalidateBillingQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingPlansRetrieveQueryKey(),
    });
  };

  const tierChangePending =
    changeMachineTierMutation.isPending ||
    changeStorageTierMutation.isPending ||
    changeCreditTierMutation.isPending;

  const machineChanged =
    selectedMachineTier != null && selectedMachineTier !== currentMachineTier;
  const storageChanged =
    selectedStorageTier != null && selectedStorageTier !== currentStorageTier;
  const creditChanged =
    creditTiersEnabled &&
    selectedCreditTier !== undefined &&
    selectedCreditTier !== currentCreditTier;

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

  // Coordinated multi-dimension tier change: fires all changed dimensions,
  // waits for all to settle, then handles completion as a single batch.
  // Fixes the race condition where the first mutation to succeed would close
  // the modal before others complete — potentially hiding later errors.
  const submitTierChanges = () => {
    if (tierChangePending) {
      return;
    }

    type DimensionResult = { dimension: string; ok: boolean; error?: unknown };
    const pending: Promise<DimensionResult>[] = [];

    if (machineChanged && selectedMachineTier) {
      pending.push(
        new Promise<DimensionResult>((resolve) => {
          changeMachineTierMutation.mutate(
            { body: { machine_tier: selectedMachineTier } },
            {
              onSuccess: () => resolve({ dimension: "machine", ok: true }),
              onError: (error) =>
                resolve({ dimension: "machine", ok: false, error }),
            },
          );
        }),
      );
    }

    if (storageChanged && selectedStorageTier) {
      pending.push(
        new Promise<DimensionResult>((resolve) => {
          changeStorageTierMutation.mutate(
            { body: { storage_tier: selectedStorageTier } },
            {
              onSuccess: () => resolve({ dimension: "storage", ok: true }),
              onError: (error) =>
                resolve({ dimension: "storage", ok: false, error }),
            },
          );
        }),
      );
    }

    if (creditChanged) {
      pending.push(
        new Promise<DimensionResult>((resolve) => {
          changeCreditTierMutation.mutate(
            { body: { credit_tier: displayCreditTier } },
            {
              onSuccess: () => resolve({ dimension: "credit", ok: true }),
              onError: (error) =>
                resolve({ dimension: "credit", ok: false, error }),
            },
          );
        }),
      );
    }

    void Promise.all(pending).then((results) => {
      invalidateBillingQueries();

      // A storage change is always an upgrade (downgrades are disabled in the
      // picker). A machine change needs the explicit downgrade check.
      const storageSucceeded = results.some(
        (r) => r.ok && r.dimension === "storage",
      );
      const machineUpgradeSucceeded =
        results.some((r) => r.ok && r.dimension === "machine") &&
        !isMachineDowngrade;
      const needsResize =
        (storageSucceeded || machineUpgradeSucceeded) && !!onTierUpgraded;

      const failures = results.filter((r) => !r.ok);

      if (failures.length > 0) {
        const msg = failures
          .map((f) =>
            extractMutationError(
              f.error,
              `Failed to update ${f.dimension} tier.`,
            ),
          )
          .join(" ");
        toast.error(msg, { id: "pro-tier-change-error" });

        // A resource tier change persisted server-side even though another
        // dimension failed — still open the resize flow so the assistant
        // picks up the new entitlement.
        if (needsResize) {
          onClose();
          onTierUpgraded!();
        }
        return;
      }

      // All succeeded — trigger the resize flow if a non-downgrade resource
      // tier changed. Machine downgrades don't need an immediate resize
      // prompt; storage changes are always upgrades (downgrades disabled).
      if (needsResize) {
        onClose();
        onTierUpgraded!();
      } else {
        toast.success(
          creditChanged && !machineChanged && !storageChanged
            ? t("adjustPlanModal.creditBundleUpdated")
            : t("adjustPlanModal.planUpdated"),
          { id: "pro-tier-change" },
        );
      }
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

  const proCurrentTotalCents = (plan: ProPlan): number | null =>
    currentMachinePrice != null && currentStoragePrice != null
      ? plan.base_price_cents +
        currentMachinePrice +
        currentStoragePrice +
        currentCreditPriceCents
      : null;

  const tierChangeError =
    changeMachineTierMutation.isError ||
    changeStorageTierMutation.isError ||
    changeCreditTierMutation.isError
      ? extractMutationError(
          changeMachineTierMutation.error ??
            changeStorageTierMutation.error ??
            changeCreditTierMutation.error,
          t("adjustPlanModal.updateFailed"),
        )
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
                  disabled={portalMutation.isPending}
                  leftIcon={<ArrowLeft className="h-4 w-4" />}
                >
                  {t("adjustPlanModal.back")}
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmDowngrade}
                  disabled={portalMutation.isPending}
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
                            tierChangeError={tierChangeError}
                            upgradePending={upgradeMutation.isPending}
                            portalPending={portalMutation.isPending}
                            onUpgrade={handleUpgrade}
                            onApplyTierChange={handleApplyTierChange}
                            onDowngradeClick={() =>
                              setView("downgrade-confirm")
                            }
                            onKeepPlan={() => portalMutation.mutate({})}
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
