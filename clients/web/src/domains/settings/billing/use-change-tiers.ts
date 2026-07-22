import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import {
  TIER_CHANGE_ELIGIBLE_STATUSES,
  extractMutationError,
} from "@/domains/settings/components/adjust-plan-utils";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionChangeCreditTierCreateMutation,
  organizationsBillingSubscriptionChangeMachineTierCreateMutation,
  organizationsBillingSubscriptionChangeStorageTierCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  MachineTierEnum,
  StorageTierEnum,
} from "@/generated/api/types.gen";

/**
 * The Pro subscription's current tier configuration, read the same way
 * `adjust-plan-modal` reads it: machine/storage from the onboarding retrieve
 * query, the credit bundle from the subscription retrieve query.
 */
export interface CurrentTiers {
  machineTier: MachineTierEnum | null;
  storageTier: StorageTierEnum | null;
  storageGib: number | null;
  creditTier: CreditTierEnum | null;
}

/** A three-dimension custom selection to apply (mirrors `CustomPlanSelection`). */
export interface ChangeTiersSelection {
  machineTier: MachineTierEnum;
  storageTier: StorageTierEnum;
  /** `null` is the explicit "No extra credits" choice. */
  creditTier: CreditTierEnum | null;
}

/** Outcome of a successful `changeTiers` dispatch. */
export interface ChangeTiersResult {
  /**
   * A machine or storage dimension changed and persisted, so the assistant
   * must provision the new compute/disk — the caller opens the resize
   * takeover. A credit-only change (or a no-op) leaves this false.
   */
  needsResize: boolean;
}

export interface UseChangeTiersResult {
  changeTiers: (
    selection: ChangeTiersSelection,
  ) => Promise<ChangeTiersResult | null>;
  isPending: boolean;
  current: CurrentTiers;
  eligible: boolean;
  /**
   * False while the onboarding query behind `current` is still loading its
   * first result for a Pro sub. `current.machineTier`/`storageTier` are null in
   * that window, so callers must wait for this before treating a config as
   * "not representable" — a false negative would misroute an eligible sub.
   */
  currentReady: boolean;
}

/**
 * Shared wiring for applying a custom tier configuration to an active Pro
 * subscription. Posts ONLY the changed dimensions to the three change-tier
 * endpoints in parallel (mirrors `adjust-plan-modal`'s `submitTierChanges`),
 * awaits them as one batch, invalidates the three billing queries, and surfaces
 * any error as a toast.
 *
 * `eligible` is true only for an active, non-cancelling Pro sub in an
 * entitlement-bearing status — the change-tier endpoints 4xx otherwise. Unlike
 * `isPackageSwitchEligible`, a customized sub is allowed: a custom tier config
 * is exactly what this flow edits.
 */
export function useChangeTiers(): UseChangeTiersResult {
  const queryClient = useQueryClient();
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const subscription = subscriptionQuery.data;
  const onPro = subscription != null && subscription.plan_id !== "base";

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: onPro,
  });

  const changeMachineTierMutation = useMutation(
    organizationsBillingSubscriptionChangeMachineTierCreateMutation(),
  );
  const changeStorageTierMutation = useMutation(
    organizationsBillingSubscriptionChangeStorageTierCreateMutation(),
  );
  const changeCreditTierMutation = useMutation(
    organizationsBillingSubscriptionChangeCreditTierCreateMutation(),
  );

  const current: CurrentTiers = {
    machineTier:
      (onboardingQuery.data?.max_machine_tier as MachineTierEnum | null) ?? null,
    storageTier:
      (onboardingQuery.data?.selected_storage_tier as StorageTierEnum | null) ??
      null,
    storageGib: onboardingQuery.data?.selected_storage_gib ?? null,
    creditTier:
      (subscription?.selected_credit_tier as CreditTierEnum | null) ?? null,
  };

  const eligible =
    subscription != null &&
    subscription.plan_id !== "base" &&
    subscription.status != null &&
    TIER_CHANGE_ELIGIBLE_STATUSES.has(subscription.status) &&
    subscription.cancel_at_period_end !== true &&
    !subscription.cancel_at;

  // For a Pro sub the current tiers come from the onboarding query, which
  // resolves after the page has already rendered. Treat them as known only once
  // that first load settles (success or error) — an error leaves the tiers null,
  // which the caller safely reads as "not representable" and routes to manage.
  const currentReady = !onPro || !onboardingQuery.isPending;

  const isPending =
    changeMachineTierMutation.isPending ||
    changeStorageTierMutation.isPending ||
    changeCreditTierMutation.isPending;

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

  const changeTiers = async (
    selection: ChangeTiersSelection,
  ): Promise<ChangeTiersResult | null> => {
    const machineChanged = selection.machineTier !== current.machineTier;
    const storageChanged = selection.storageTier !== current.storageTier;
    const creditChanged = selection.creditTier !== current.creditTier;

    type DimensionResult = {
      dimension: "machine" | "storage" | "credit";
      ok: boolean;
      error?: unknown;
    };
    const pending: Promise<DimensionResult>[] = [];

    if (machineChanged) {
      pending.push(
        new Promise<DimensionResult>((resolve) => {
          changeMachineTierMutation.mutate(
            { body: { machine_tier: selection.machineTier } },
            {
              onSuccess: () => resolve({ dimension: "machine", ok: true }),
              onError: (error) =>
                resolve({ dimension: "machine", ok: false, error }),
            },
          );
        }),
      );
    }

    if (storageChanged) {
      pending.push(
        new Promise<DimensionResult>((resolve) => {
          changeStorageTierMutation.mutate(
            { body: { storage_tier: selection.storageTier } },
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
            { body: { credit_tier: selection.creditTier } },
            {
              onSuccess: () => resolve({ dimension: "credit", ok: true }),
              onError: (error) =>
                resolve({ dimension: "credit", ok: false, error }),
            },
          );
        }),
      );
    }

    // Nothing diverged from the current config — treat as a successful no-op so
    // the caller closes the modal without opening the resize takeover.
    if (pending.length === 0) {
      return { needsResize: false };
    }

    const results = await Promise.all(pending);
    invalidateBillingQueries();

    // Storage here is always an upgrade (the modal disables downgrades) and any
    // machine change resizes the assistant, so a succeeded resource dimension
    // means the assistant must provision the new ceiling.
    const needsResize = results.some(
      (r) => r.ok && (r.dimension === "machine" || r.dimension === "storage"),
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      const message = failures
        .map((f) =>
          extractMutationError(f.error, `Failed to update ${f.dimension} tier.`),
        )
        .join(" ");
      toast.error(message);
      // A resource dimension can persist server-side even when another one
      // fails, so still surface the resize takeover to provision it; the caller
      // closes the modal. Only when nothing landed do we return null to hold the
      // modal open for a retry.
      return needsResize ? { needsResize: true } : null;
    }

    return { needsResize };
  };

  return { changeTiers, isPending, current, eligible, currentReady };
}
