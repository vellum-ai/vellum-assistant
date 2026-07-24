import { ArrowLeft, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  isCleanPin,
  PACKAGE_ORDER,
  type ProPackage,
  type SwitchRelation,
  tierRelation,
} from "@/domains/settings/billing/package-types";
import {
  machineLabel,
  STANDARD_MACHINE_LABEL,
} from "@/domains/settings/billing/plan-spec";
import type { CurrentTiers } from "@/domains/settings/billing/use-change-tiers";
import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import {
  CustomPlanModal,
  type CustomPlanSeed,
  type CustomPlanSelection,
} from "@/domains/settings/billing/plans/custom-plan-modal";
import { CustomPlanRow } from "@/domains/settings/billing/plans/custom-plan-row";
import { FreeDowngradeConfirmModal } from "@/domains/settings/billing/plans/free-downgrade-confirm-modal";
import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import { PlanColumnCard } from "@/domains/settings/billing/plans/plan-column-card";
import {
  downgradeLabel,
  getPlanTierCopy,
} from "@/domains/settings/billing/plans/plans-copy";
import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { findCreditTier } from "@/domains/settings/billing/pro-onboarding/use-provisioning-credits";
import { useChangePackage } from "@/domains/settings/billing/use-change-package";
import { useChangeTiers } from "@/domains/settings/billing/use-change-tiers";
import { useCheckoutDismissRefresh } from "@/domains/settings/billing/use-checkout-dismiss-refresh";
import {
  extractMutationError,
  isPackageSwitchEligible,
} from "@/domains/settings/components/adjust-plan-utils";
import { formatDollars } from "@/domains/settings/components/tier-pricing";
import {
  buildPortalReturnSnapshot,
  useBillingPortalSession,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTierEnum,
  ProPlan,
  SubscriptionUpgradeRequestRequest,
} from "@/generated/api/types.gen";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { MACHINE_TIER_LABEL } from "@/lib/billing/machine-sizes";
import { openUrl } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { routes } from "@/utils/routes";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

// Near-black takeover canvas. No surface token holds this value — the darkest
// dark-theme surface is `--surface-base` (#17191C) — so the raw hex stands.
const PAGE_BACKGROUND = "#0A0A0B";

// External pricing docs — the closest existing docs link in the web client
// (also used by the AI settings pricing banner).
const DOCS_URL = "https://www.vellum.ai/docs/pricing";

// The screen is a wall of creature avatars; warm the bundled component chunk at
// module load so they resolve before first paint instead of popping in.
preloadBundledAvatarComponents();

const FREE_FEATURES: readonly string[] = [
  "Small Computer",
  `${FREE_STORAGE_GIB} GB Storage`,
  "Pay-as-you-go credits",
];

/** "$50/month" (or "$0/month"). */
function priceLabelFromCents(cents: number): string {
  return `${formatDollars(cents)}/month`;
}

/** Machine label for a package's feature row, e.g. "Medium Computer". */
function machineComputerLabel(pkg: ProPackage): string {
  return `${machineLabel(pkg)} Computer`;
}

/** Catalog-derived feature rows, plus any static extras from the copy. */
function packageFeatures(pkg: ProPackage, extra: readonly string[]): string[] {
  const credits = pkg.credits_usd ?? FREE_CREDITS_USD;
  return [
    machineComputerLabel(pkg),
    `${pkg.storage_gib} GB Storage`,
    `${formatDollars(credits * 100)} in credits included`,
    ...extra,
  ];
}

/**
 * A one-line recap of a custom sub's current tiers for the Custom row, e.g.
 * "Medium Machine · 30 GB · 50 credits". The machine reads from the tier label
 * map (or the standard-machine baseline), storage from the resolved GiB, and
 * the credit label from the live catalog's `CreditTier.label`; a dimension with
 * no value is dropped. The wording mirrors `packageSpecs` in `plan-spec.ts`.
 */
function customCurrentSummary(current: CurrentTiers, proPlan: ProPlan): string {
  const machine = current.machineTier
    ? (MACHINE_TIER_LABEL[current.machineTier] ?? current.machineTier)
    : STANDARD_MACHINE_LABEL;
  const parts = [`${machine} Machine`];
  if (current.storageGib != null) {
    parts.push(`${current.storageGib} GB`);
  }
  if (current.creditTier != null) {
    // A held/deprecated credit tier absent from the catalog can't resolve to a
    // catalog label; derive the amount from the tier key (credits_<usd>) so the
    // paid bundle still shows instead of being silently dropped.
    const usd = current.creditTier.match(/^credits_(\d+)$/)?.[1];
    parts.push(
      findCreditTier(proPlan, current.creditTier)?.label ??
        (usd != null ? `${usd} credits` : "Credit bundle"),
    );
  }
  return parts.join(" · ");
}

/**
 * Full-screen "View Plans" pricing takeover at `/assistant/plans`. Always dark
 * regardless of the app theme; the recommended column flips back to light
 * within its own theme scope. Renders from the live plan catalog — with the
 * `pro-packages` flag off the catalog is empty and the route bounces back to
 * the billing page.
 */
export function PlansPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const electron = isElectron();

  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const lifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const platformReady = platformGate === "full" && isPlatformHosted;
  // Hosting still resolving on a deep-link — hold the spinner, don't redirect.
  const platformResolving = platformGate === "full" && lifecycleLoading;

  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: platformReady,
  });
  const plansQuery = useQuery({
    ...organizationsBillingPlansRetrieveOptions(),
    enabled: platformReady,
  });
  const upgradeMutation = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const { changePackage, isPending: changePackagePending } = useChangePackage();
  const {
    changeTiers,
    isPending: changeTiersPending,
    current,
    currentReady,
  } = useChangeTiers({ enabled: platformReady });
  // Native iOS keeps Checkout inside an in-app sheet, so the page holds
  // pre-checkout data until the sheet closes.
  useCheckoutDismissRefresh();
  const [pending, setPending] = useState(false);
  const [customPlanOpen, setCustomPlanOpen] = useState(false);
  // Whether the Pro → Free cancellation confirm dialog is open.
  const [freeDowngradeOpen, setFreeDowngradeOpen] = useState(false);
  // The package a Pro user is switching to, awaiting reconfirm; null when the
  // dialog is closed.
  const [switchTarget, setSwitchTarget] = useState<ProPackage | null>(null);
  // Reveals the in-tab provisioning takeover after a successful switch or
  // customize — `BillingOnboardingModal` in resize mode, which only observes
  // the grow-only resize the platform already fired server-side (no redundant
  // client-driven resize).
  const [resizeTakeoverOpen, setResizeTakeoverOpen] = useState(false);
  // The credit tier applied by an in-place change, threaded to the takeover's
  // terminal confirmation. See `ProvisioningStateProps.resizeCredits`.
  const [resizeCreditTier, setResizeCreditTier] = useState<
    CreditTierEnum | null | undefined
  >(undefined);

  const subscription = subscriptionQuery.data;
  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );
  const packages = proPlan?.packages ?? [];
  const hasPackages = packages.length > 0;
  const isProUser = subscription?.plan_id === "pro";

  // Pro → Free is a cancellation: after a confirm step it opens the Stripe
  // billing portal (the same destination as the adjust-plan modal's "Downgrade
  // to Base") so the user can cancel there. Snapshot the pre-redirect state for
  // the post-return toast.
  const portalMutation = useBillingPortalSession(
    buildPortalReturnSnapshot(subscription),
  );

  // Pro features lost by downgrading to Free — the confirm dialog lists these.
  const baseFeatureSet = new Set(
    plansQuery.data?.plans.find((p) => p.id === "base")?.included_features ?? [],
  );
  const freeDowngradeLostFeatures = (proPlan?.included_features ?? []).filter(
    (f) => !baseFeatureSet.has(f),
  );

  // Any billing action in flight — a checkout, a package switch, or the Stripe
  // portal opening — disables every plan CTA (and Configure) so a second click
  // can't start a competing billing operation before the first resolves.
  const billingActionPending =
    pending || changePackagePending || portalMutation.isPending;

  // Seed the custom-plan modal with the Pro sub's current tiers so an unrelated
  // edit (e.g. only the machine) doesn't force re-picking — and dropping — the
  // storage or credit the user still holds. Null for base checkout, which
  // starts every dimension empty.
  const customInitialSelection = useMemo<CustomPlanSeed | null>(() => {
    if (!isProUser || current.storageTier == null) {
      return null;
    }
    // `machineTier` may be null for a baseline (Small) package — the modal
    // seeds storage/credit and leaves the machine picker empty in that case.
    return {
      machineTier: current.machineTier,
      storageTier: current.storageTier,
      creditTier: current.creditTier,
    };
  }, [isProUser, current.machineTier, current.storageTier, current.creditTier]);

  // The takeover only makes sense against a platform-hosted assistant with a
  // live package catalog. Anything else — self-hosted or no platform session,
  // an empty catalog (the `pro-packages` flag off), or a subscription we can't
  // read — has nothing to show, so fall back to the billing page.
  const notPlatformHosted = !platformReady && !platformResolving;
  const catalogEmpty = platformReady && !plansQuery.isLoading && !hasPackages;
  const cannotResolve =
    notPlatformHosted || subscriptionQuery.isError || catalogEmpty;
  useEffect(() => {
    if (cannotResolve) {
      navigate(routes.settings.usageBilling, { replace: true });
    }
  }, [cannotResolve, navigate]);

  const handleBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
    } else {
      navigate(routes.settings.usageBilling);
    }
  };

  const startCheckout = async (body: SubscriptionUpgradeRequestRequest) => {
    setPending(true);
    try {
      const result = await upgradeMutation.mutateAsync({
        body: { ...body, return_target: checkoutReturnTarget() },
      });
      if (result.status === "redirect" && result.checkout_url) {
        // Stash the selection so the post-checkout provisioning screen can
        // show the purchased upgrade before the subscribe webhook lands.
        saveCheckoutIntent(
          body.package
            ? { kind: "package", packageKey: body.package }
            : {
                kind: "custom",
                machineTier: body.machine_tier ?? null,
                storageTier: body.storage_tier ?? null,
                creditTier: body.credit_tier ?? null,
              },
        );
        openUrl(result.checkout_url);
      } else {
        await queryClient.invalidateQueries({
          queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: organizationsBillingPlansRetrieveQueryKey(),
        });
      }
    } catch (error) {
      toast.error(
        extractMutationError(
          error,
          "Failed to start the upgrade checkout. Please try again.",
        ),
      );
    } finally {
      setPending(false);
    }
  };

  let body: ReactNode;
  if (subscription && proPlan && hasPackages) {
    // A Custom sub (unpinned or customized) has no meaningful catalog rank, so
    // it has no current tier: every named card is offered as a switch target —
    // including a customized sub's own pinned key, which is a real
    // revert-to-stock operation.
    const currentTierKey =
      subscription.plan_id === "base"
        ? "free"
        : isCleanPin(subscription.package)
          ? subscription.package.key
          : null;

    // A Pro sub with no clean pin (unpinned, customized, or legacy) — exactly
    // the subs `currentTierKey` leaves null — is represented by the Custom row,
    // not any named card. Mark that row as their current plan and summarize its
    // tiers, once the current tiers have loaded.
    const isCustomCurrent = isProUser && currentTierKey === null;
    const currentSummary =
      isCustomCurrent && currentReady
        ? customCurrentSummary(current, proPlan)
        : undefined;

    const selectTier = (tierKey: string) => {
      // A billing action is already in flight (checkout / package switch /
      // portal opening) — ignore the click. The CTAs are also disabled; this
      // guards against a race between the click and the disabled re-render.
      if (billingActionPending) {
        return;
      }
      if (isProUser) {
        if (tierKey === "free") {
          // Pro → Free is a subscription cancellation, not a package switch.
          // Confirm first (which Pro features are lost), then open the Stripe
          // billing portal — the same destination as the adjust-plan modal's
          // "Downgrade to Base" — where the user actually cancels. The
          // package-only change-package endpoint 400s on non-package keys.
          setFreeDowngradeOpen(true);
          return;
        }
        // Active Pro orgs switch packages in place via the change-package
        // endpoint (up or down). Only the named Pro packages route here.
        const pkg = packages.find((p) => p.key === tierKey);
        if (!pkg) {
          return;
        }
        if (tierRelation(currentTierKey, pkg.key) === "current") {
          return;
        }
        // Any active Pro sub — pinned, unpinned, or customized — switches in
        // place via change-package. Only a cancelling or non-entitlement-status
        // sub can't; route it to the billing manage/cancel surface instead of
        // posting a change-package that can only fail (the same fallback the
        // Pro → Free case uses).
        if (!isPackageSwitchEligible(subscription)) {
          navigate(`${routes.settings.usage}?tab=billing&adjust_plan`);
          return;
        }
        setSwitchTarget(pkg);
        return;
      }
      if (tierKey === "free") {
        return;
      }
      // A package checkout resolves its own line items server-side; only the
      // package key is sent (mirrors the plan-card upgrade path).
      void startCheckout({
        target_plan_id: "pro",
        package: tierKey,
        confirm: true,
      });
    };

    // Confirmed Pro → Free cancellation: close the confirm and hand off to the
    // Stripe billing portal, where the actual cancellation happens.
    const confirmFreeDowngrade = () => {
      setFreeDowngradeOpen(false);
      portalMutation.mutate({});
    };

    const confirmSwitch = async () => {
      if (!switchTarget) {
        return;
      }
      const target = switchTarget;
      const relation = tierRelation(currentTierKey, target.key);
      const result = await changePackage(target.key);
      if (!result) {
        // The hook already toasted; keep the confirm dialog open so the user
        // can retry.
        return;
      }
      setSwitchTarget(null);
      if (result.status === "no_op") {
        // Already on this package — nothing to provision.
        toast.success("You're already on this plan.");
        return;
      }
      // status === "ok": only an upgrade grows the machine, so only it needs
      // the resize/provisioning takeover. A downgrade caps the machine down
      // immediately server-side with no apply/restart step, so just confirm it.
      // A Custom-sub switch has unknown direction, so it lands here as "upgrade"
      // and opens the takeover — the provisioning step is grow-only/idempotent
      // server-side, so it is the safe default when direction is unknown.
      if (relation === "downgrade") {
        toast.success(`Downgraded to ${target.name}.`);
      } else {
        // The switch path owes no credit confirmation; clear any prior tier.
        setResizeCreditTier(undefined);
        setResizeTakeoverOpen(true);
      }
    };

    // A Custom sub (currentTierKey null) can't be ranked against the target, so
    // the confirm copy stays direction-neutral ("switch"); a clean-pinned sub
    // gets the directional up/down copy.
    const switchRelation: SwitchRelation = switchTarget
      ? currentTierKey === null
        ? "switch"
        : tierRelation(currentTierKey, switchTarget.key) === "downgrade"
          ? "downgrade"
          : "upgrade"
      : "upgrade";

    const startCustomCheckout = (selection: CustomPlanSelection) =>
      startCheckout({
        target_plan_id: "pro",
        confirm: true,
        machine_tier: selection.machineTier,
        storage_tier: selection.storageTier,
        credit_tier: selection.creditTier,
      });

    // Active Pro orgs edit their tiers in place via the change-tier endpoints;
    // the upgrade/checkout endpoint no-ops for an active Pro sub.
    const applyCustomTierChange = async (selection: CustomPlanSelection) => {
      const result = await changeTiers(selection);
      if (!result) {
        // The hook toasted; keep the modal open so the user can retry.
        return;
      }
      setCustomPlanOpen(false);
      if (result.needsResize || result.creditChanged) {
        // Both a resize and a credit-only change open the takeover; thread the
        // applied tier only when credits actually changed.
        setResizeCreditTier(
          result.creditChanged ? selection.creditTier : undefined,
        );
        setResizeTakeoverOpen(true);
      } else {
        toast.success("Plan updated.");
      }
    };

    const handleConfigure = () => {
      // Don't open the configurator while another billing action is in flight
      // (the CTA is also disabled — see `configureDisabled`).
      if (billingActionPending) {
        return;
      }
      // A Pro sub's current tiers load after the page renders; the modal seeds
      // from them, so hold the click until that first load settles (the CTA is
      // also held disabled meanwhile — see `configureDisabled`).
      if (isProUser && !currentReady) {
        return;
      }
      setCustomPlanOpen(true);
    };

    const orderedPackages = [...packages].sort(
      (a, b) =>
        PACKAGE_ORDER.indexOf(a.key as (typeof PACKAGE_ORDER)[number]) -
        PACKAGE_ORDER.indexOf(b.key as (typeof PACKAGE_ORDER)[number]),
    );
    const freeCopy = getPlanTierCopy("free");
    // Pro → Free is always a downgrade (cancellation), even for a Custom sub
    // whose currentTierKey is null; `selectTier("free")` cancel routing is
    // unchanged.
    const freeRelation = isProUser
      ? "downgrade"
      : tierRelation(currentTierKey, "free");

    body = (
      <div className="my-auto flex w-full flex-col items-center">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1
            className="text-[var(--content-emphasised)]"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "60px",
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: "1.2px",
            }}
          >
            Give your assistant more power
          </h1>
          <p className="text-[20px] font-medium text-[var(--content-tertiary)]">
            Choose the level that matches how much you want it to take on.
          </p>
        </header>

        {/* Shrinks the four columns to fit as the viewport narrows, reflowing
            to two-up then one-up; `items-start` keeps each card at its natural
            content height, so the four-feature Super/Ultra columns are taller
            than the featured Mighty column. */}
        <div className="mt-10 grid w-full max-w-[1312px] grid-cols-1 items-start gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <PlanColumnCard
            tierKey="free"
            name="Free"
            tagline={freeCopy?.tagline ?? ""}
            priceLabel="$0/month"
            priceCaption={freeCopy?.priceCaption ?? "Forever"}
            ctaLabel={
              freeRelation === "downgrade"
                ? downgradeLabel("Free")
                : (freeCopy?.cta ?? "Start Free")
            }
            features={FREE_FEATURES}
            tone="dark"
            isCurrent={currentTierKey === "free"}
            intent={freeRelation}
            pending={billingActionPending}
            onCta={() => selectTier("free")}
          />
          {orderedPackages.map((pkg) => {
            const copy = getPlanTierCopy(pkg.key);
            const relation = tierRelation(currentTierKey, pkg.key);
            return (
              <PlanColumnCard
                key={pkg.key}
                tierKey={pkg.key}
                name={pkg.name}
                tagline={copy?.tagline ?? ""}
                priceLabel={priceLabelFromCents(pkg.total_price_cents)}
                priceCaption={copy?.priceCaption ?? "Billed monthly"}
                ctaLabel={
                  relation === "downgrade"
                    ? downgradeLabel(pkg.name)
                    : (copy?.cta ?? pkg.name)
                }
                features={packageFeatures(pkg, copy?.extraFeatures ?? [])}
                recommended={copy?.recommended}
                tone={copy?.recommended ? "light" : "dark"}
                isCurrent={currentTierKey === pkg.key}
                intent={relation}
                pending={billingActionPending}
                onCta={() => selectTier(pkg.key)}
              />
            );
          })}
        </div>

        <CustomPlanRow
          className="mt-10"
          onConfigure={handleConfigure}
          configureDisabled={(isProUser && !currentReady) || billingActionPending}
          isCurrent={isCustomCurrent && currentReady}
          currentSummary={currentSummary}
        />

        <CustomPlanModal
          open={customPlanOpen}
          proPlan={proPlan}
          pending={pending || changeTiersPending}
          currentStorageGib={isProUser ? current.storageGib : null}
          initialSelection={customInitialSelection}
          onClose={() => setCustomPlanOpen(false)}
          onContinue={(selection) => {
            if (isProUser) {
              void applyCustomTierChange(selection);
            } else {
              void startCustomCheckout(selection);
            }
          }}
        />

        <PackageSwitchConfirmModal
          open={switchTarget !== null}
          relation={switchRelation}
          packageName={switchTarget?.name ?? ""}
          pending={changePackagePending}
          onCancel={() => setSwitchTarget(null)}
          onConfirm={() => void confirmSwitch()}
        />

        <FreeDowngradeConfirmModal
          open={freeDowngradeOpen}
          lostFeatures={freeDowngradeLostFeatures}
          pending={portalMutation.isPending}
          onCancel={() => setFreeDowngradeOpen(false)}
          onConfirm={confirmFreeDowngrade}
        />

        <BillingOnboardingModal
          mode="resize"
          open={resizeTakeoverOpen}
          onClose={() => {
            setResizeTakeoverOpen(false);
            // Fail-safe: clear the tier so a stale credit chip can't resurface
            // if an open path forgot to set it.
            setResizeCreditTier(undefined);
          }}
          resizeCredits={resizeCreditTier}
        />

        <p className="mt-10 text-center text-[12px] font-medium text-[var(--content-tertiary)]">
          You can cancel or change your plan anytime you want. To learn more{" "}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--content-default)] underline"
          >
            Read our Docs.
          </a>
        </p>
      </div>
    );
  } else {
    body = (
      <div className="my-auto flex items-center justify-center">
        <Loader2
          className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
          aria-label="Loading plans"
        />
      </div>
    );
  }

  return (
    <div
      data-theme="dark"
      className="plans-takeover-canvas-enter relative h-full w-full overflow-y-auto"
      style={{ backgroundColor: PAGE_BACKGROUND }}
    >
      {/* WindowDragRegion handles title-bar dragging globally; the chip opts
          back out so it stays clickable over the drag surface. */}
      <div
        className="absolute left-8 z-10 [-webkit-app-region:no-drag]"
        style={{ top: electron ? "3rem" : "2rem" }}
      >
        <Button
          variant="outlined"
          leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden />}
          onClick={handleBack}
          className="[-webkit-app-region:no-drag]"
        >
          Back
        </Button>
      </div>

      <div
        className="plans-takeover-content-enter flex min-h-full flex-col items-center px-6 pb-8"
        style={{ paddingTop: electron ? "5rem" : "4rem" }}
      >
        {body}
      </div>
    </div>
  );
}
