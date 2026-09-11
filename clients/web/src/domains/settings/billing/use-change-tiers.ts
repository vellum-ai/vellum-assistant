import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import {
  TIER_CHANGE_ELIGIBLE_STATUSES,
  extractMutationError,
} from "@/domains/settings/components/adjust-plan-utils";
import { invalidateBillingQueries } from "@/domains/settings/billing/invalidate-billing-queries";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingSubscriptionChangePackageCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  MachineTierEnum,
  PackageChangeResponse,
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
  /**
   * Whether the sub bills the base platform fee. Only the Mighty package is
   * sold without it, and a custom plan always carries it, so a fee-less sub
   * submitting its own tiers as a custom plan is a real change (the fee is
   * added and billed). Read as true when the server omits the field.
   */
  hasPlatformFee: boolean;
}

/** A three-dimension custom selection to apply (mirrors `CustomPlanSelection`). */
export interface ChangeTiersSelection {
  /**
   * `null` is the baseline machine. Only a sub already on the baseline can
   * submit it (the configurator offers it to no one else), so it always equals
   * `current.machineTier` and dispatches nothing.
   */
  machineTier: MachineTierEnum | null;
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
 * subscription. Posts the whole selection as ONE change-package call with
 * explicit tiers (the server diffs it against the subscription and applies
 * every dimension, plus the platform fee a custom plan always carries, in one
 * payment-gated change), invalidates the billing queries, and surfaces any
 * error as a toast.
 *
 * `eligible` is true only for an active, non-cancelling Pro sub in an
 * entitlement-bearing status — change-package 4xxs otherwise. A
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

  const changePackageMutation = useMutation(
    organizationsBillingSubscriptionChangePackageCreateMutation(),
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
    hasPlatformFee: subscription?.has_platform_fee ?? true,
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

  const isPending = changePackageMutation.isPending;

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

    // A custom plan always carries the platform fee, so a fee-less (Mighty)
    // sub re-submitting its own tiers is still a change: the fee is added.
    const feeAdded = !current.hasPlatformFee;

    // Nothing diverged from the current config — treat as a successful no-op so
    // the caller closes the modal without opening the resize takeover.
    if (!machineChanged && !storageChanged && !creditChanged && !feeAdded) {
      return { needsResize: false, creditChanged: false };
    }

    let status: PackageChangeResponse["status"];
    try {
      const result = await changePackageMutation.mutateAsync({
        body: {
          machine_tier: selection.machineTier,
          storage_tier: selection.storageTier,
          credit_tier: selection.creditTier,
        },
      });
      status = result.status;
    } catch (error) {
      // The change is atomic server-side (a declined card rolls it back), so
      // nothing landed; the caller holds the modal open for a retry.
      toast.error(
        extractMutationError(
          error,
          "Failed to change your plan. Please try again.",
        ),
      );
      return null;
    }
    // Await the refetches so a resize-needed result resolves only once the
    // takeover can read the new ceiling instead of the stale cache.
    await invalidateBillingQueries(queryClient);
    if (status === "no_op") {
      return { needsResize: false, creditChanged: false };
    }

    // Storage is always an upgrade (the modal disables downgrades). A machine
    // change needs a resize only when it grows the ceiling — a downgrade is
    // capped server-side with no provisioning step. Either resource grow means
    // the assistant must provision.
    const needsResize =
      storageChanged || (machineChanged && !machineIsDowngrade);
    // A persisted credit-bundle change surfaces the takeover without owing any
    // compute/disk provisioning, so it is tracked apart from `needsResize`.
    return { needsResize, creditChanged };
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
