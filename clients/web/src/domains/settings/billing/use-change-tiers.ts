import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import {
  TIER_CHANGE_ELIGIBLE_STATUSES,
  extractMutationError,
} from "@/domains/settings/components/adjust-plan-utils";
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
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

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
   * A resource dimension grew and persisted — a storage upgrade or a machine
   * upgrade — so the assistant must provision the new compute/disk and the
   * caller opens the resize takeover. A machine downgrade, a credit-only
   * change, or a no-op leaves this false. Credits are kept out of it so
   * downstream resize logic stays keyed on "the assistant must provision".
   */
  needsResize: boolean;
  /**
   * The credit bundle changed and persisted. Reported alongside `needsResize`
   * so the caller can surface the takeover for a credit-only change (a readable
   * confirmation moment) even though no compute/disk provisioning is owed.
   * False for a machine/storage-only change or a no-op.
   */
  creditChanged: boolean;
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
  /**
   * Whether `current`'s server-read dimensions were actually READ: for a Pro
   * sub, the onboarding payload behind them is in hand. `currentReady` only
   * says that read settled, so it is true for one that failed, and a failed
   * read leaves `machineTier` null, which is exactly what a package naming no
   * machine reports. Callers that rank the machine tier must consult this and
   * treat an unread tier as unknown rather than as the machine-less floor.
   */
  currentKnown: boolean;
  /**
   * The assistant the server provisions against, from the same onboarding
   * payload `current` reads, and only when that payload is trustworthy: it
   * carries `currentKnown`'s gate for the same reason the tiers do. Null when
   * the org names no primary or the read cannot be trusted, so callers must
   * decide for themselves whether an unknown target is safe to guess at.
   */
  primaryAssistantId: string | null;
}

/**
 * Shared wiring for applying a custom tier configuration to an active Pro
 * subscription. Posts ONLY the changed dimensions to the three change-tier
 * endpoints in parallel (mirrors `adjust-plan-modal`'s `submitTierChanges`),
 * awaits them as one batch, invalidates the three billing queries, and surfaces
 * any error as a toast.
 *
 * `eligible` is true only for an active, non-cancelling Pro sub in an
 * entitlement-bearing status — the change-tier endpoints 4xx otherwise. A
 * customized sub qualifies: editing a custom tier config is exactly what this
 * flow does. This mirrors `isPackageSwitchEligible`, which also admits
 * customized (and unpinned) Pro subs; the difference is that this flow edits
 * individual tiers in place, while the package switch re-pins to a named plan.
 *
 * Pass `enabled` (the caller's platform-hosted gate) to hold the org-scoped
 * reads until the page is ready; they are also gated on org-header readiness.
 */
export function useChangeTiers({
  enabled = true,
}: { enabled?: boolean } = {}): UseChangeTiersResult {
  const queryClient = useQueryClient();
  // These are org-scoped reads, so hold them until the caller is ready (its own
  // platform-hosted gate) and the org header source has hydrated — otherwise a
  // request can fire without `Vellum-Organization-Id` and 4xx.
  const orgReady = useIsOrgReady();
  const ready = enabled && orgReady;
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: ready,
  });
  const subscription = subscriptionQuery.data;
  const onPro = subscription != null && subscription.plan_id !== "base";

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: ready && onPro,
  });
  // Supplies the machine-tier prices used to tell an upgrade from a downgrade,
  // the same way `adjust-plan-modal` reads them. Already cached by the plans
  // page, so this is a deduped read.
  const plansQuery = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled: ready && onPro,
  });
  const machineTiers =
    plansQuery.data?.plans.find((p): p is ProPlan => p.id === "pro")
      ?.machine_tiers ?? [];
  const machinePriceCents = (tier: MachineTierEnum | null): number | null =>
    machineTiers.find((t) => t.tier === tier)?.price_cents ?? null;

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
      (onboardingQuery.data?.max_machine_tier as MachineTierEnum | null) ??
      null,
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
  // Whether these tiers can be trusted to describe the sub right now, which is
  // stricter than `currentReady` and exists because ranking a wrong machine
  // tier silently grants a downgrade the no-op inference only a raise earns.
  //
  // Every state the query can be in that does not answer "yes":
  //   - never loaded: no payload, every dimension null
  //   - loaded with no payload: a successful read of nothing, same nulls
  //   - failed outright: same nulls, and null is what a machine-less package
  //     legitimately reports, so it cannot be told apart from one
  //   - failed over cached data: payload retained, real but no longer current
  //   - re-reading cached data: payload retained and possibly about to change
  //
  // A settled read is still not enough on its own, because these tiers are
  // ranked against a subscription read from a different query. The client holds
  // both for `staleTime` without refetching, so a subscription refreshed on its
  // own can be paired with onboarding describing the plan before it: a fresh
  // Ultra sub beside a cached machine-less payload ranks a step down as a step
  // up. The two have to be read from the same moment or later, so the payload
  // must not predate the subscription it is being compared against.
  //
  // Callers treat everything else as unrankable, which costs a fast path and
  // never costs correctness.
  const currentKnown =
    !onPro ||
    (onboardingQuery.isSuccess &&
      onboardingQuery.data != null &&
      !onboardingQuery.isFetching &&
      onboardingQuery.dataUpdatedAt >= subscriptionQuery.dataUpdatedAt);

  const isPending =
    changeMachineTierMutation.isPending ||
    changeStorageTierMutation.isPending ||
    changeCreditTierMutation.isPending;

  // Awaited before a resize-needed result resolves so the takeover reads the
  // refetched onboarding ceiling, not the stale cache (mirrors the
  // package-switch path).
  const invalidateBillingQueries = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: organizationsBillingPlansRetrieveQueryKey(),
      }),
    ]);

  const changeTiers = async (
    selection: ChangeTiersSelection,
  ): Promise<ChangeTiersResult | null> => {
    const machineChanged = selection.machineTier !== current.machineTier;
    const storageChanged = selection.storageTier !== current.storageTier;
    const creditChanged = selection.creditTier !== current.creditTier;

    // A machine change that lowers the price is a downgrade — capped down
    // server-side with no provisioning step — so it must not open the resize
    // takeover (mirrors `adjust-plan-modal`'s price-based check).
    const nextMachinePrice = machinePriceCents(selection.machineTier);
    const currentMachinePrice = machinePriceCents(current.machineTier);
    const machineIsDowngrade =
      machineChanged &&
      nextMachinePrice != null &&
      currentMachinePrice != null &&
      nextMachinePrice < currentMachinePrice;

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
      return { needsResize: false, creditChanged: false };
    }

    const results = await Promise.all(pending);
    // Await the refetches so a resize-needed result resolves only once the
    // takeover can read the new ceiling instead of the stale cache.
    await invalidateBillingQueries();

    // Storage is always an upgrade (the modal disables downgrades). A machine
    // change needs a resize only when it grows the ceiling — a downgrade is
    // capped server-side with no provisioning step. Either succeeded resource
    // grow means the assistant must provision.
    const machineUpgradeSucceeded =
      results.some((r) => r.ok && r.dimension === "machine") &&
      !machineIsDowngrade;
    const storageSucceeded = results.some(
      (r) => r.ok && r.dimension === "storage",
    );
    const needsResize = machineUpgradeSucceeded || storageSucceeded;
    // A persisted credit-bundle change surfaces the takeover without owing any
    // compute/disk provisioning, so it is tracked apart from `needsResize`.
    const creditSucceeded = results.some(
      (r) => r.ok && r.dimension === "credit",
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      const message = failures
        .map((f) =>
          extractMutationError(
            f.error,
            `Failed to update ${f.dimension} tier.`,
          ),
        )
        .join(" ");
      toast.error(message);
      // A resource or credit dimension can persist server-side even when another
      // one fails, so still surface the takeover for what landed; the caller
      // closes the modal. Only when nothing landed do we return null to hold the
      // modal open for a retry.
      return needsResize || creditSucceeded
        ? { needsResize, creditChanged: creditSucceeded }
        : null;
    }

    return { needsResize, creditChanged: creditSucceeded };
  };

  return {
    changeTiers,
    isPending,
    current,
    eligible,
    currentReady,
    currentKnown,
    // Only from a payload we trust. This names the pod a caller will read tier
    // values off, and a stale payload can name the org's previous primary while
    // the takeover resolves the current one from its own read, which would
    // describe two different machines as one change.
    primaryAssistantId: currentKnown
      ? (onboardingQuery.data?.primary_assistant_id ?? null)
      : null,
  };
}
