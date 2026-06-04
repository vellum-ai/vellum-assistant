import { AlertTriangle, ArrowLeft, Crown, Loader2, Palmtree } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Tag } from "@vellum/design-library/components/tag";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import { CreditBundlePicker } from "./credit-bundle-picker";
import { DowngradeReconfirmModal } from "./downgrade-reconfirm-modal";
import { PlanFeatureList } from "./plan-feature-list";
import { TierPicker, isTierDisabled } from "./tier-picker";
import type {
  CreditTier,
  CreditTierEnum,
  MachineTier,
  MachineTierEnum,
  ProPlan,
  StorageTier,
  StorageTierEnum,
  SubscriptionStatusEnum,
} from "@/generated/api/types.gen";
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
import {
  buildPortalReturnSnapshot,
  formatGraceDate,
  getEffectiveCancelDate,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";


/**
 * Subscription statuses for which Pro tier changes are permitted. Mirrors the
 * backend `ENTITLEMENT_BEARING_STATUSES` (subscription_service.py) that
 * `is_pro_active` (app/billing/entitlements.py) checks — the
 * `change_machine_tier` / `change_storage_tier` endpoints return 403 for any
 * other status. Pro orgs in non-entitlement statuses (`unpaid`, `incomplete`,
 * `paused`, etc.) must not be shown a tier-change CTA that cannot succeed.
 */
const TIER_CHANGE_ELIGIBLE_STATUSES: ReadonlySet<SubscriptionStatusEnum> =
  new Set<SubscriptionStatusEnum>(["active", "trialing", "past_due"]);

/**
 * Extract a user-facing message from a subscription mutation error.
 *
 * DRF field errors arrive as `{ field_name: [message, ...] }`; we probe the
 * known fields and fall back to `detail` then a caller-provided generic.
 */
const DRF_FIELD_KEYS = [
  "target_plan_id",
  "confirm",
  "machine_tier",
  "storage_tier",
  "credit_tier",
  "non_field_errors",
] as const;

function extractMutationError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    for (const key of DRF_FIELD_KEYS) {
      if (key in error) {
        const msgs = (error as Record<string, unknown>)[key];
        if (Array.isArray(msgs) && typeof msgs[0] === "string") {
          return msgs[0];
        }
      }
    }
    if ("detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
  }
  return fallback;
}

/**
 * Resolve which tier should be selected given the user's previous choice and
 * the current tier list. Keeps `prev` only if it is still present AND enabled;
 * otherwise falls back to the first enabled tier (or null when none qualify).
 *
 * Revalidating against the live list guards the case where a plans refetch
 * removes or disables the previously-selected tier while the modal is open —
 * the CTA's non-null gate alone would otherwise let the user submit a stale or
 * now-disabled tier that the server rejects.
 */
export function resolveTierSelection<T extends string>(
  tiers: (MachineTier | StorageTier)[],
  prev: T | null,
): T | null {
  const enabled = tiers.filter((t) => !isTierDisabled(t));
  if (prev !== null && enabled.some((t) => t.tier === prev)) {
    return prev;
  }
  return (enabled[0]?.tier ?? null) as T | null;
}

/**
 * Resolve which credit tier should be selected given the previous selection,
 * the resolved current bundle, and the live catalog. Mirrors
 * `resolveTierSelection` but for credit bundles, which have no disabled state
 * and where both `null` ("No bundle") and a catalog tier are valid selections.
 *
 * `prev` carries the sentinel meaning: `undefined` is un-seeded (the effect has
 * not yet seeded a value), so we seed to `current`. A non-undefined `prev`
 * (including an explicit `null` for "No bundle") is the user's standing choice
 * and must be preserved — we keep it, only revalidating a concrete tier against
 * the catalog so a refetch that removes the selected bundle falls back to
 * "No bundle" rather than leaving a stale tier the CTA would submit.
 */
export function resolveCreditTierSelection(
  tiers: CreditTier[],
  prev: CreditTierEnum | null | undefined,
  current: CreditTierEnum | null,
): CreditTierEnum | null {
  const seeded = prev === undefined ? current : prev;
  if (seeded !== null && tiers.some((t) => t.tier === seeded)) {
    return seeded;
  }
  return null;
}

/**
 * Cheapest tier price in cents, or 0 when the list is empty. Guards the
 * "From $" summary against `Math.min(...[])` → `Infinity` (which would render
 * "From $Infinity"). Production plans always carry populated tier arrays, so
 * this only matters defensively.
 */
function minTierPriceCents(tiers: (MachineTier | StorageTier)[]): number {
  return tiers.length ? Math.min(...tiers.map((t) => t.price_cents)) : 0;
}

export interface AdjustPlanModalProps {
  open: boolean;
  onClose: () => void;
  onTierUpgraded?: () => void;
}

export function AdjustPlanModal({ open, onClose, onTierUpgraded }: AdjustPlanModalProps) {
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
  // `null` is the user's explicit "No bundle" choice. Machine/storage don't need
  // this distinction because `null` is never a valid selection for them, but for
  // credits both values are meaningful — see `creditChanged` and the seeding
  // effect for why conflating them caused spurious bundle removals.
  const [selectedCreditTier, setSelectedCreditTier] =
    useState<CreditTierEnum | null | undefined>(undefined);

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
      // The onboarding endpoint carries the per-org tier ceilings
      // (`max_machine_tier`, `selected_storage_gib`) that the Storage &
      // Resources ResizeCard renders as its limits. A tier change updates those
      // ceilings server-side, so its cache must be invalidated too — otherwise
      // the card keeps showing the pre-upgrade limits until a hard reload.
      void queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      });
      onClose();
    });
  }, [queryClient, onClose]);

  const currentPlanId = subscriptionQuery.data?.plan_id;
  const onPro = currentPlanId === "pro";

  // Reads the org's current Pro selection (max machine tier + storage tier/GiB)
  // — the same source ResizeCard uses. Pro-only endpoint, so skip until plan
  // resolves to avoid firing it for Base users.
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

  // Only entitlement-bearing Pro statuses (active/trialing/past_due) can change
  // tiers — the backend tier-change endpoints 403 otherwise. Statuses like
  // `unpaid`/`incomplete`/`paused` fall through to the non-tier-change rendering.
  const tierChangeEligibleStatus = TIER_CHANGE_ELIGIBLE_STATUSES.has(
    subscriptionQuery.data?.status as SubscriptionStatusEnum,
  );

  // An active (non-cancelling) Pro subscriber adjusts their existing tiers
  // rather than upgrading from Base. Tier changes are gated off entirely while
  // a cancellation is pending — that path offers only reactivation.
  const proTierChangeMode =
    onPro && tierChangeEligibleStatus && !cancelAtPeriodEnd && !isCanceled;

  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );

  // Credit bundles are server-flag-gated via the catalog: render the picker and
  // run the credit logic only when the Pro plan ships a non-empty `credit_tiers`
  // list. When absent, the modal behaves exactly as before.
  const creditTiers = proPlan?.credit_tiers ?? [];
  const creditTiersEnabled = creditTiers.length > 0;

  // Unlike machine/storage (read from the onboarding endpoint), the current
  // credit bundle lives on the subscription response. Coerce to the enum so the
  // picker seed and price lookup share one source of truth.
  const currentCreditTier =
    (subscriptionQuery.data?.selected_credit_tier as CreditTierEnum | null) ??
    null;
  const priceForCredit = (tier: CreditTierEnum | null): number =>
    creditTiers.find((t) => t.tier === tier)?.price_cents ?? 0;
  const currentCreditPriceCents = priceForCredit(currentCreditTier);

  // The picker and the mutation bodies require `CreditTierEnum | null` — never
  // the un-seeded `undefined` sentinel. While un-seeded, fall back to the
  // current bundle (which is `null` for a Base user upgrading), matching what
  // the seeding effect will resolve to so display and the pre-seed value agree.
  const displayCreditTier: CreditTierEnum | null =
    selectedCreditTier === undefined ? currentCreditTier : selectedCreditTier;

  // For an active Pro subscriber, disable any storage tier strictly below the
  // current selection — downgrading storage is not allowed. TierPicker honors
  // the `disabled` flag via `isTierDisabled`; machine tiers stay fully enabled
  // (changes up and down are permitted). For a Base user upgrading, the live
  // tiers are used unchanged.
  const machineTiersForPicker = proPlan?.machine_tiers ?? [];
  const storageTiersForPicker =
    proTierChangeMode && currentStorageGib != null
      ? (proPlan?.storage_tiers ?? []).map((t) =>
          t.storage_gib < currentStorageGib ? { ...t, disabled: true } : t,
        )
      : (proPlan?.storage_tiers ?? []);

  // Seed selections when the modal opens and the relevant data lands.
  //   - Active Pro: seed to the current tiers (from onboarding state) so the
  //     pickers reflect what the user has today; wait for onboarding to land.
  //   - Base upgrade: default to the first *enabled* tier.
  // `resolveTierSelection` revalidates the prior/seed choice against the live
  // list, so a refetch that disables or removes the selected tier re-seeds
  // rather than leaving a stale value the CTA's non-null gate would submit.
  // Reset to null on close; stays null when none qualify.
  useEffect(() => {
    if (!open) {
      setSelectedMachineTier(null);
      setSelectedStorageTier(null);
      // Reset to the un-seeded sentinel (not null, which is a valid "No bundle"
      // choice) so the next open re-seeds from the current bundle.
      setSelectedCreditTier(undefined);
      return;
    }
    if (!proPlan) return;
    if (proTierChangeMode) {
      // Hold off seeding until current tiers are known so we don't briefly
      // seed to the cheapest and then snap to the current selection.
      if (currentMachineTier == null || currentStorageTier == null) return;
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
      // Seed the credit bundle from the subscription's current selection only
      // while un-seeded (`prev === undefined`); once the user has chosen,
      // `resolveCreditTierSelection` preserves their choice — including an
      // explicit `null` ("No bundle") — and only revalidates a concrete tier
      // against the live catalog. This stops a mid-modal refetch from snapping a
      // pending removal back to the existing bundle.
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
    // Base upgrade has no current bundle, so it seeds to null ("No bundle",
    // $0); `resolveCreditTierSelection` then preserves any prior choice and
    // revalidates a concrete tier against the live catalog.
    setSelectedCreditTier((prev) =>
      resolveCreditTierSelection(creditTiers, prev, null),
    );
    // machineTiersForPicker/storageTiersForPicker/creditTiers are derived from
    // proPlan + onboarding values already in the dep list; omitting them keeps
    // the effect from re-running on each render's fresh array identity.
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

  const handleUpgrade = () => {
    if (upgradeMutation.isPending) return;
    if (!selectedMachineTier || !selectedStorageTier) {
      toast.error("Pick a machine and storage tier to continue.", {
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
          // null = "No bundle". The backend ignores this when the credit-bundles
          // flag is off, so always sending it is safe.
          credit_tier: displayCreditTier,
        },
      },
      {
        onSuccess: (data) => {
          if (data.checkout_url) {
            void openUrl(data.checkout_url);
            return;
          }
          if (data.status === "no_op") {
            toast.info("You're already on Pro.", { id: "pro-upgrade" });
            onClose();
            return;
          }
          toast.error(
            data.message ?? "Failed to start upgrade. Please try again.",
            { id: "pro-upgrade-error" },
          );
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              "Failed to start upgrade. Please try again.",
            ),
            { id: "pro-upgrade-error" },
          );
        },
      },
    );
  };

  const handleConfirmDowngrade = () => {
    if (portalMutation.isPending) return;
    setView("plans");
    portalMutation.mutate({});
  };

  // After a tier change lands, the subscription, onboarding state, and plans
  // queries are all stale (price, current tiers, derived disabled flags).
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

  // What changed vs. the current selection. Storage downgrades are impossible
  // (those tiers are disabled), so a storage diff is always an upgrade. The
  // credit bundle is its own dimension; `null` ("No bundle") is a valid value,
  // so we compare directly rather than gating on non-null.
  const machineChanged =
    selectedMachineTier != null && selectedMachineTier !== currentMachineTier;
  const storageChanged =
    selectedStorageTier != null && selectedStorageTier !== currentStorageTier;
  // Gate on `!== undefined` (un-seeded) the way machine/storage gate on
  // `!= null` — until the effect seeds, there is no user-intended change, so a
  // pre-seed `undefined` vs. existing `currentCreditTier` must not enable the
  // CTA or submit `credit_tier: null`. Once seeded, `null` ("No bundle") is a
  // valid value, so we compare directly rather than gating on non-null.
  const creditChanged =
    creditTiersEnabled &&
    selectedCreditTier !== undefined &&
    selectedCreditTier !== currentCreditTier;

  const priceForMachine = (tier: MachineTierEnum | null): number | null =>
    machineTiersForPicker.find((t) => t.tier === tier)?.price_cents ?? null;
  const priceForStorage = (tier: StorageTierEnum | null): number | null =>
    storageTiersForPicker.find((t) => t.tier === tier)?.price_cents ?? null;
  // A machine downgrade (cheaper than current) routes through the reconfirm
  // modal first; an upgrade fires immediately.
  const nextMachinePrice = priceForMachine(selectedMachineTier);
  const currentMachinePrice = priceForMachine(currentMachineTier);
  const currentStoragePrice = priceForStorage(currentStorageTier);
  const isMachineDowngrade =
    machineChanged &&
    nextMachinePrice != null &&
    currentMachinePrice != null &&
    nextMachinePrice < currentMachinePrice;

  const submitMachineTierChange = () => {
    if (tierChangePending || !selectedMachineTier) return;
    changeMachineTierMutation.mutate(
      { body: { machine_tier: selectedMachineTier } },
      {
        onSuccess: () => {
          invalidateBillingQueries();
          if (!isMachineDowngrade && onTierUpgraded) {
            onClose();
            onTierUpgraded();
          } else {
            toast.success("Machine tier updated.", { id: "pro-tier-change" });
          }
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              "Failed to change machine tier. Please try again.",
            ),
            { id: "pro-tier-change-error" },
          );
        },
      },
    );
  };

  const submitStorageTierChange = () => {
    if (tierChangePending || !selectedStorageTier) return;
    changeStorageTierMutation.mutate(
      { body: { storage_tier: selectedStorageTier } },
      {
        onSuccess: () => {
          invalidateBillingQueries();
          if (onTierUpgraded) {
            onClose();
            onTierUpgraded();
          } else {
            toast.success("Storage tier updated.", { id: "pro-tier-change" });
          }
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              "Failed to change storage tier. Please try again.",
            ),
            { id: "pro-tier-change-error" },
          );
        },
      },
    );
  };

  const submitCreditTierChange = () => {
    if (tierChangePending) return;
    changeCreditTierMutation.mutate(
      // null removes the bundle ("No bundle"). Bundle changes apply at the next
      // cycle — no proration/immediate-charge subtleties — so no reconfirm.
      // `creditChanged` already gates out the un-seeded state, so this only runs
      // with a seeded value, but coalesce defensively to never send `undefined`.
      { body: { credit_tier: displayCreditTier } },
      {
        onSuccess: () => {
          // Refresh billing so the plan card and this modal reflect the new
          // bundle. A credit change never alters machine/storage resources, so
          // it must not invoke `onTierUpgraded` (the assistant resize flow) —
          // that would show an unrelated resize prompt and fire needless
          // resource queries. `submitTierChanges` still opens the resize flow
          // when a machine or storage dimension also changed.
          invalidateBillingQueries();
          toast.success("Credit bundle updated.", { id: "pro-tier-change" });
        },
        onError: (error) => {
          toast.error(
            extractMutationError(
              error,
              "Failed to change credit bundle. Please try again.",
            ),
            { id: "pro-tier-change-error" },
          );
        },
      },
    );
  };

  // Fire only the dimension(s) that actually changed.
  const submitTierChanges = () => {
    if (machineChanged) submitMachineTierChange();
    if (storageChanged) submitStorageTierChange();
    if (creditChanged) submitCreditTierChange();
  };

  // When the machine tier is being lowered, defer the whole apply behind the
  // reconfirm modal so the user confirms the smaller compute profile before
  // anything is committed.
  const handleApplyTierChange = () => {
    if (tierChangePending) return;
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
              <Modal.Header>
                <Modal.Title icon={AlertTriangle}>Downgrade to Base?</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                <Typography
                  as="p"
                  variant="body-medium-default"
                  className="text-(--content-secondary)"
                >
                  Downgrading removes the following Pro features:
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
                  Back
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmDowngrade}
                  disabled={portalMutation.isPending}
                  data-testid="confirm-downgrade-button"
                >
                  Confirm Downgrade
                </Button>
              </Modal.Footer>
            </>
          ) : (
            <>
          <Modal.Header>
            <Modal.Title className="sr-only">Upgrade Plan</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {isLoading ? (
              <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <Typography as="span" variant="body-medium-lighter">
                  Loading plans...
                </Typography>
              </div>
            ) : isError ? (
              <Notice tone="error">
                Failed to load plans. Please try again later.
              </Notice>
            ) : (
              <div className="space-y-6">
                <div className="space-y-2 pb-2 pt-4 text-center">
                  <Typography as="p" variant="title-medium">
                    Your Assistant, Your Way
                  </Typography>
                  <Typography
                    as="p"
                    variant="body-medium-lighter"
                    className="text-[var(--content-secondary)]"
                  >
                    Choose the plan that works best for you and your assistant.
                  </Typography>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {plansQuery.data!.plans.map((plan) => {
                    const isCurrent = plan.id === currentPlanId;
                    const isProCard = plan.id === "pro";
                    const isBaseCard = plan.id === "base";
                    const showCancellationOnPro =
                      isProCard && onPro && cancelAtPeriodEnd && !isCanceled;
                    // Active Pro subscriber adjusting tiers on their current Pro
                    // card (suppressed entirely while cancellation is pending —
                    // that path shows only reactivation).
                    const showProTierChange =
                      isProCard && isCurrent && proTierChangeMode;
                    return (
                      <Card
                        key={plan.id}
                        padding="lg"
                        className="flex flex-col bg-[var(--surface-base)]"
                      >
                        <div className="flex flex-col gap-4">
                          <span
                            aria-hidden
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]"
                          >
                            {isProCard ? (
                              <Crown className="h-5 w-5 text-[var(--content-default)]" />
                            ) : (
                              <Palmtree className="h-5 w-5 text-[var(--content-default)]" />
                            )}
                          </span>
                          <div className="flex min-h-6 items-center gap-2">
                            <Typography as="h3" variant="title-small">
                              {plan.name}
                            </Typography>
                            {isCurrent && <Tag tone="positive">Current</Tag>}
                          </div>
                          <Typography
                            as="p"
                            variant="body-small-default"
                            className="-mt-2 text-[var(--content-tertiary)]"
                          >
                            {isBaseCard
                              ? "All you need for a capable assistant"
                              : "More features, more compute, more storage"}
                          </Typography>
                          {showCancellationOnPro && cancelDate && (
                            <Typography
                              as="p"
                              variant="body-small-default"
                              className="text-[var(--system-mid-strong)]"
                              data-testid="modal-cancels-on"
                            >
                              Your plan ends on {formatGraceDate(cancelDate)}
                            </Typography>
                          )}
                          <hr className="border-t border-[var(--border-base)]" />
                          <div className="flex flex-col gap-1">
                            {isBaseCard ? (
                              <>
                                <Typography as="p" variant="title-medium">
                                  Free
                                </Typography>
                                <Typography
                                  as="p"
                                  variant="body-small-default"
                                  className="text-[var(--content-tertiary)]"
                                >
                                  Forever
                                </Typography>
                              </>
                            ) : proTierChangeMode &&
                              currentMachinePrice != null &&
                              currentStoragePrice != null ? (
                              <>
                                <Typography as="p" variant="title-medium">
                                  Currently $
                                  {Math.round(
                                    (plan.base_price_cents +
                                      currentMachinePrice +
                                      currentStoragePrice +
                                      currentCreditPriceCents) /
                                      100,
                                  )}
                                </Typography>
                                <Typography
                                  as="p"
                                  variant="body-small-default"
                                  className="text-[var(--content-tertiary)]"
                                >
                                  Billed monthly
                                </Typography>
                              </>
                            ) : (
                              <>
                                <Typography as="p" variant="title-medium">
                                  From $
                                  {Math.round(
                                    (plan.base_price_cents +
                                      minTierPriceCents(plan.machine_tiers) +
                                      minTierPriceCents(plan.storage_tiers)) /
                                      100,
                                  )}
                                </Typography>
                                <Typography
                                  as="p"
                                  variant="body-small-default"
                                  className="text-[var(--content-tertiary)]"
                                >
                                  Billed monthly
                                </Typography>
                              </>
                            )}
                          </div>
                          <PlanFeatureList
                            features={plan.included_features}
                            variant="checklist"
                          />
                          {isProCard && (
                            <Typography
                              as="p"
                              variant="body-small-default"
                              className="text-[var(--content-tertiary)]"
                            >
                              *Credits not included
                            </Typography>
                          )}
                        </div>
                        <div className="mt-4 flex flex-1 flex-col justify-end gap-4">
                          {!isCurrent && isProCard && (
                            <>
                              <hr className="border-t border-[var(--border-base)]" />
                              <TierPicker
                                machineTiers={plan.machine_tiers}
                                storageTiers={plan.storage_tiers}
                                basePriceCents={plan.base_price_cents}
                                selectedMachineTier={selectedMachineTier}
                                selectedStorageTier={selectedStorageTier}
                                onMachineTierChange={setSelectedMachineTier}
                                onStorageTierChange={setSelectedStorageTier}
                              />
                              {creditTiersEnabled && (
                                <CreditBundlePicker
                                  creditTiers={creditTiers}
                                  selectedCreditTier={displayCreditTier}
                                  onCreditTierChange={setSelectedCreditTier}
                                  disabled={upgradeMutation.isPending}
                                />
                              )}
                              <Button
                                variant="primary"
                                className="w-full"
                                onClick={handleUpgrade}
                                disabled={
                                  upgradeMutation.isPending ||
                                  !selectedMachineTier ||
                                  !selectedStorageTier
                                }
                                data-testid="modal-upgrade-to-pro-button"
                              >
                                Upgrade to Pro
                              </Button>
                            </>
                          )}
                          {showProTierChange &&
                            (onboardingQuery.isLoading ? (
                              <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <Typography
                                  as="span"
                                  variant="body-medium-lighter"
                                >
                                  Loading your plan...
                                </Typography>
                              </div>
                            ) : (
                              <>
                                <hr className="border-t border-[var(--border-base)]" />
                                <TierPicker
                                  machineTiers={machineTiersForPicker}
                                  storageTiers={storageTiersForPicker}
                                  basePriceCents={plan.base_price_cents}
                                  selectedMachineTier={selectedMachineTier}
                                  selectedStorageTier={selectedStorageTier}
                                  onMachineTierChange={setSelectedMachineTier}
                                  onStorageTierChange={setSelectedStorageTier}
                                  currentMachinePriceCents={currentMachinePrice}
                                  currentStoragePriceCents={currentStoragePrice}
                                />
                                {creditTiersEnabled && (
                                  <CreditBundlePicker
                                    creditTiers={creditTiers}
                                    selectedCreditTier={displayCreditTier}
                                    onCreditTierChange={setSelectedCreditTier}
                                    currentCreditPriceCents={
                                      currentCreditPriceCents
                                    }
                                    disabled={tierChangePending}
                                  />
                                )}
                                {(changeMachineTierMutation.isError ||
                                  changeStorageTierMutation.isError ||
                                  changeCreditTierMutation.isError) && (
                                  <Notice tone="error">
                                    {extractMutationError(
                                      changeMachineTierMutation.error ??
                                        changeStorageTierMutation.error ??
                                        changeCreditTierMutation.error,
                                      "Failed to update plan. Please try again.",
                                    )}
                                  </Notice>
                                )}
                                <Button
                                  variant="primary"
                                  className="w-full"
                                  onClick={handleApplyTierChange}
                                  disabled={
                                    tierChangePending ||
                                    (!machineChanged &&
                                      !storageChanged &&
                                      !creditChanged)
                                  }
                                  data-testid="modal-change-tier-button"
                                >
                                  Update Plan
                                </Button>
                              </>
                            ))}
                          {!isCurrent &&
                            isBaseCard &&
                            onPro &&
                            !cancelAtPeriodEnd && (
                              <>
                                <hr className="border-t border-[var(--border-base)]" />
                                <Button
                                  variant="outlined"
                                  className="w-full"
                                  onClick={() => setView("downgrade-confirm")}
                                  disabled={portalMutation.isPending}
                                  data-testid="modal-downgrade-to-base-button"
                                >
                                  Downgrade to Base
                                </Button>
                              </>
                            )}
                          {showCancellationOnPro && (
                            <>
                              <hr className="border-t border-[var(--border-base)]" />
                              <Button
                                variant="outlined"
                                className="w-full"
                                onClick={() => portalMutation.mutate({})}
                                disabled={portalMutation.isPending}
                                data-testid="modal-keep-plan-button"
                              >
                                Keep your Plan
                              </Button>
                            </>
                          )}
                        </div>
                      </Card>
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
                You can change or cancel your plan at any time from billing settings.
              </span>
            </Typography>
            <div className="ml-auto">
              <Button
                variant="outlined"
                onClick={onClose}
                data-testid="modal-cancel-button"
              >
                Cancel
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
          "Reduced CPU and memory for your assistant — it will resize to the smaller compute profile.",
        ]}
      />
    </>
  );
}
