import { Loader2 } from "lucide-react";

import { useMemo, useState } from "react";

import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  isCleanPin,
  nextPackageUp,
  proPackageDisplayName,
  type ProPackage,
  type SwitchRelation,
} from "@/domains/settings/billing/package-types";
import { PlanPromoCard } from "@/domains/settings/billing/plan-promo-card";
import { useChangePackage } from "@/domains/settings/billing/use-change-package";
import { useChangeTiers } from "@/domains/settings/billing/use-change-tiers";
import {
  CustomPlanModal,
  type CustomPlanSeed,
  type CustomPlanSelection,
} from "@/domains/settings/billing/plans/custom-plan-modal";
import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import { packageSpecs } from "@/domains/settings/billing/plan-spec";
import { PlanSpecCard } from "@/domains/settings/billing/plan-spec-card";
import { useCheckoutDismissRefresh } from "@/domains/settings/billing/use-checkout-dismiss-refresh";
import {
  formatGraceDate,
  getEffectiveCancelDate,
} from "@/domains/settings/hooks/use-billing-portal-session";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { ProPlan } from "@/generated/api/types.gen";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { openUrl } from "@/runtime/browser";
import { routes } from "@/utils/routes";
import type { ButtonProps } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import {
  extractMutationError,
  isPackageSwitchEligible,
} from "./adjust-plan-utils";

interface PlanDisplay {
  actionLabel: string;
  actionVariant: ButtonProps["variant"];
  actionTestId: string;
  showsRenewal: boolean;
}

const PLAN_DISPLAY: Record<string, PlanDisplay> = {
  pro: {
    actionLabel: "Manage",
    actionVariant: "outlined",
    actionTestId: "plan-card-manage-button",
    showsRenewal: true,
  },
  base: {
    actionLabel: "View All Plans",
    actionVariant: "primary",
    actionTestId: "plan-card-upgrade-button",
    showsRenewal: true,
  },
};

const DEFAULT_DISPLAY: PlanDisplay = PLAN_DISPLAY.pro;

export interface PlanCardProps {
  onManage: () => void;
  /**
   * Raised after a Pro user's in-place package upgrade succeeds — opens the
   * provisioning takeover (resize modal), the same signal `AdjustPlanModal`
   * emits after a tier change.
   */
  onTierUpgraded?: () => void;
}

function PlanHeading() {
  return (
    <Typography
      as="h2"
      variant="title-medium"
      className="text-[var(--content-emphasised)]"
    >
      Plan
    </Typography>
  );
}

interface RecommendedUpgradeProps {
  packages: ProPackage[];
  /**
   * The live Pro plan from the catalog, supplying the machine/storage/credit
   * tiers the `CustomPlanModal` configures. Undefined only when the Pro plan is
   * absent from the catalog — in which case there is no customize path to offer.
   */
  proPlan: ProPlan | undefined;
  currentKey: string | null;
  /**
   * Whether the org already has a Pro subscription. Pro users change their
   * package in place (prorated) via the change-package endpoint; base users
   * go through Stripe checkout.
   */
  isProUser: boolean;
  /**
   * Whether this Pro sub is eligible for a one-click, in-place package switch:
   * true for any switch-eligible Pro sub — a clean pin, a customized pin, or an
   * unpinned (Custom) sub. A cancelling or non-entitlement Pro sub falls back to
   * the manage path. Meaningless for base users, whose CTA always routes to
   * Stripe checkout.
   */
  canChangePackage: boolean;
  /**
   * How the target package relates to the current sub. A clean pin's next
   * package is an "upgrade" (the promo "Upgrade to X" variant); a customized or
   * unpinned (Custom) sub gets "switch", which routes to the "Create a custom
   * plan" variant instead.
   */
  relation: SwitchRelation;
  /**
   * Manage-path delegate (AdjustPlanModal). Handles a cancelling or
   * non-entitlement Pro sub that the change-package/change-tier flows cannot
   * act on.
   */
  onManage: () => void;
  /**
   * Opens the provisioning takeover (resize modal) after a Pro user's in-place
   * package or tier change succeeds — the same signal the tier-change flow
   * raises.
   */
  onTierUpgraded?: () => void;
}

function RecommendedUpgrade({
  packages,
  proPlan,
  currentKey,
  isProUser,
  canChangePackage,
  relation,
  onManage,
  onTierUpgraded,
}: RecommendedUpgradeProps) {
  const queryClient = useQueryClient();
  const upgradeMutation = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const { changePackage, isPending: changePending } = useChangePackage();
  // The customize variant edits the Pro sub's tiers in place; only enable the
  // hook's org-scoped reads for a Pro sub (a base user never sees that variant).
  const {
    changeTiers,
    isPending: changeTiersPending,
    current,
    currentReady,
  } = useChangeTiers({ enabled: isProUser });
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [customPlanOpen, setCustomPlanOpen] = useState(false);
  // Native iOS keeps Checkout inside an in-app sheet; refetch when it closes.
  useCheckoutDismissRefresh();

  // Seed the custom-plan modal with the Pro sub's current tiers so an unrelated
  // edit doesn't force re-picking — and dropping — a dimension the user still
  // holds. Null until the current tiers load (mirrors plans-page).
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

  const recommended = nextPackageUp(packages, currentKey);
  const hasCatalog = packages.length > 0;

  // Upgrade variant: base users and Pro clean pins with a stronger package to
  // step up to. A neutral "switch" (customized/unpinned sub) is never an
  // upgrade — it routes to the customize variant below instead.
  const showUpgrade = recommended != null && relation !== "switch";
  // Customize variant: a Pro sub whose tiers can diverge from stock (customized
  // or unpinned, i.e. relation "switch"), or a clean pin already on the top
  // catalog package (no package left to upgrade to). Both open the new
  // CustomPlanModal. Requires a live catalog — with the flag off there are no
  // tiers to configure.
  const showCustomize =
    isProUser &&
    hasCatalog &&
    (relation === "switch" ||
      (recommended == null &&
        currentKey != null &&
        packages.some((p) => p.key === currentKey)));

  const isPending = pending || upgradeMutation.isPending || changePending;

  // Pro users change their package in place: confirm the prorated charge, then
  // call change-package and hand off to the resize takeover on success. Base
  // users go through the Stripe-checkout path instead.
  const handleConfirmChange = async () => {
    if (!recommended) {
      return;
    }
    const result = await changePackage(recommended.key);
    if (!result) {
      // The hook already toasted; leave the dialog open so the user can
      // retry.
      return;
    }
    setConfirmOpen(false);
    if (result.status === "ok") {
      onTierUpgraded?.();
    } else {
      // no_op: the sub is already on this package, so there's nothing to
      // provision — just dismiss the confirm.
      toast.success("You're already on this plan.");
    }
  };

  const handleUpgrade = async () => {
    if (!recommended) {
      return;
    }
    // Any switch-eligible Pro sub (a clean pin, a customized pin, or an
    // unpinned Custom sub) can be one-click package-switched; a cancelling or
    // non-entitlement Pro sub stays on the manage path.
    if (isProUser && !canChangePackage) {
      onManage();
      return;
    }
    if (isProUser) {
      setConfirmOpen(true);
      return;
    }
    setPending(true);
    try {
      // A package checkout resolves its own line items server-side;
      // explicit tiers / include_platform_fee alongside `package` are
      // rejected by the upgrade serializer.
      const result = await upgradeMutation.mutateAsync({
        body: {
          target_plan_id: "pro",
          package: recommended.key,
          confirm: true,
          return_target: checkoutReturnTarget(),
        },
      });
      if (result.status === "redirect" && result.checkout_url) {
        // Stash the purchased package so the provisioning screen can
        // show it before the subscribe webhook lands — and so it can't
        // read a stale intent left by an abandoned earlier checkout.
        saveCheckoutIntent({
          kind: "package",
          packageKey: recommended.key,
        });
        // Stripe returns with a `session_id`, which opens the
        // post-checkout Pro onboarding wizard — via the billing page on
        // web, via the `billing/checkout-complete` deep link on macOS.
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

  // Active Pro orgs edit their tiers in place via the change-tier endpoints,
  // mirroring AdjustPlanModal's billing-page semantics (not plans-page's). The
  // billing-page resize takeover is credit-agnostic — `onTierUpgraded` is
  // argument-less and opens a resize-only takeover with no credit prop — so a
  // credit-only change must toast instead of popping a blank takeover.
  const applyCustomTierChange = async (selection: CustomPlanSelection) => {
    const result = await changeTiers(selection);
    if (!result) {
      // The hook toasted; keep the modal open so the user can retry.
      return;
    }
    setCustomPlanOpen(false);
    // Only a real machine/storage resize hands off to the takeover; a
    // credit-only change toasts, like AdjustPlanModal.
    if (result.needsResize) {
      onTierUpgraded?.();
    } else {
      toast.success(
        result.creditChanged ? "Credit bundle updated." : "Plan updated.",
      );
    }
  };

  // The customize CTA opens the configurator; a switch-ineligible sub (cancelling
  // or non-entitlement status) falls back to the manage path, like the upgrade
  // CTA. Guard the open like plans-page's `handleConfigure`: hold until the
  // current tiers load and no tier change is in flight.
  const handleCustomize = () => {
    if (!canChangePackage) {
      onManage();
      return;
    }
    if (changeTiersPending || !currentReady) {
      return;
    }
    // `currentReady` also flips true when the current-tier read settles with an
    // error or a missing storage tier, leaving `customInitialSelection` null.
    // Opening the configurator unseeded would let a submit diff the user's
    // selections against null current tiers and overwrite tiers they already
    // hold, so route to manage (which reads tiers independently) instead.
    if (customInitialSelection == null) {
      onManage();
      return;
    }
    setCustomPlanOpen(true);
  };
  // Disable only when the modal-open path is the live one — a switch-ineligible
  // sub keeps the CTA enabled so it can reach the manage fallback.
  const customizeDisabled =
    canChangePackage && (changeTiersPending || !currentReady);

  if (showUpgrade) {
    return (
      <>
        <PlanPromoCard
          className="lg:flex-[2]"
          title={`Upgrade to ${recommended.name}`}
          blurb={getPlanTierCopy(recommended.key)?.upgradeBlurb}
          ctaLabel="Upgrade"
          ctaTestId="recommended-upgrade-button"
          pending={isPending}
          onCtaClick={() => void handleUpgrade()}
        />
        <PackageSwitchConfirmModal
          open={confirmOpen}
          relation={relation}
          packageName={recommended.name}
          pending={isPending}
          onConfirm={() => void handleConfirmChange()}
          onCancel={() => setConfirmOpen(false)}
        />
      </>
    );
  }

  if (showCustomize && proPlan) {
    return (
      <>
        <PlanPromoCard
          className="lg:flex-[2]"
          title="Create a custom plan"
          ctaLabel="Customize"
          ctaTestId="recommended-customize-button"
          pending={changeTiersPending}
          disabled={customizeDisabled}
          onCtaClick={handleCustomize}
        />
        <CustomPlanModal
          open={customPlanOpen}
          proPlan={proPlan}
          pending={changeTiersPending}
          currentStorageGib={current.storageGib}
          initialSelection={customInitialSelection}
          onClose={() => setCustomPlanOpen(false)}
          onContinue={(selection) => void applyCustomTierChange(selection)}
        />
      </>
    );
  }

  return null;
}

export function PlanCard({ onManage, onTierUpgraded }: PlanCardProps) {
  const navigate = useNavigate();
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const plansQuery = useQuery(organizationsBillingPlansRetrieveOptions());

  if (subscriptionQuery.isLoading || plansQuery.isLoading) {
    return (
      <Card padding="md">
        <PlanHeading />
        <div className="mt-4 flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Typography as="span" variant="body-small-default">
            Loading plan...
          </Typography>
        </div>
      </Card>
    );
  }

  const subscription = subscriptionQuery.data;
  const plans = plansQuery.data?.plans;
  const currentPlan = plans?.find((p) => p.id === subscription?.plan_id);

  if (
    subscriptionQuery.isError ||
    plansQuery.isError ||
    !subscription ||
    !plans ||
    !currentPlan
  ) {
    return <Notice tone="error">Failed to load plan.</Notice>;
  }

  const display = PLAN_DISPLAY[currentPlan.id] ?? DEFAULT_DISPLAY;
  const planName =
    currentPlan.id === "pro"
      ? proPackageDisplayName(subscription.package)
      : (currentPlan.name ?? currentPlan.id);

  const isCancelling =
    display.showsRenewal &&
    (subscription.cancel_at_period_end === true ||
      Boolean(subscription.cancel_at));
  const isCanceled = subscription.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscription);
  const showRenewal =
    display.showsRenewal &&
    !isCancelling &&
    !isCanceled &&
    subscription.current_period_end;
  const showCancellation =
    display.showsRenewal && isCancelling && !isCanceled && cancelDate;

  const proPlan = plans.find((p): p is ProPlan => p.id === "pro");
  // Empty while the `pro-packages` flag is off — the upgrade banner no-ops.
  const packages = proPlan?.packages ?? [];
  const currentKey = subscription.package?.key ?? null;
  const currentTier = currentKey ?? "free";
  // A live packages catalog opens the plans takeover for base and clean-pinned
  // Pro subs, and for a custom/unpinned Pro sub that is switch-eligible. An
  // ineligible custom sub — pending cancellation, or a non-entitlement status
  // such as `unpaid` — keeps the manage modal, which surfaces its state and the
  // recovery actions; the takeover can't act on it (every change is rejected),
  // and a clean pin already reaches the manage surface through its package CTA.
  // An empty catalog (the `pro-packages` flag off) has no takeover to open, so
  // Manage falls back to the manage modal.
  const canOpenPlansTakeover =
    packages.length > 0 &&
    (currentPlan.id === "base" ||
      isCleanPin(subscription.package) ||
      isPackageSwitchEligible(subscription));
  // The banner's one-click switch is offered to any switch-eligible Pro sub —
  // a clean pin, a customized pin, or an unpinned (Custom) sub — inheriting the
  // shared eligibility gate. The confirm copy adapts to the sub's state via
  // `switchRelation`.
  const canChangePackage = isPackageSwitchEligible(subscription);
  // A base user (Stripe checkout) and a clean-pinned Pro sub both make a real
  // upgrade, so the banner keeps its directional copy and stock chips. Only a
  // Custom Pro sub — a customized pin or an unpinned legacy sub, whose real
  // tiers can diverge from any stock package — gets the direction-neutral
  // switch, since a stock delta could misstate the change.
  const switchRelation: SwitchRelation =
    currentPlan.id === "base" || isCleanPin(subscription.package)
      ? "upgrade"
      : "switch";

  const isFreePlan = currentPlan.id === "base";
  // Chips render only for a paid plan whose stock package specs are known.
  // Free shows a minimal centered card (no chips); a clean pin absent from the
  // catalog and a customized/unpinned "Custom" sub show no chips either (never
  // fall back to the free baseline, which would mislabel a paid sub).
  const currentPackage =
    !isFreePlan && isCleanPin(subscription.package)
      ? (packages.find((p) => p.key === currentKey) ?? null)
      : null;
  const currentSpecs = currentPackage ? packageSpecs(currentPackage) : null;

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <PlanHeading />
            {showRenewal && (
              <Typography
                variant="body-small-default"
                as="div"
                className="leading-snug text-[var(--content-tertiary)]"
                data-testid="plan-card-renews"
              >
                Monthly Payment &bull; Your subscription will auto renew on{" "}
                {formatGraceDate(subscription.current_period_end!)}.
              </Typography>
            )}
            {showCancellation && (
              <Typography
                variant="body-small-default"
                as="div"
                className="leading-snug text-[var(--system-mid-strong)]"
                data-testid="plan-card-cancels"
              >
                Your plan ends on {formatGraceDate(cancelDate!)}.
              </Typography>
            )}
          </div>
          <Button
            variant={display.actionVariant}
            onClick={
              canOpenPlansTakeover ? () => navigate(routes.plans) : onManage
            }
            data-testid={display.actionTestId}
            className="shrink-0"
          >
            {display.actionLabel}
          </Button>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
          <PlanSpecCard
            tierKey={currentTier}
            name={planName}
            nameTestId="plan-card-name"
            className="lg:flex-[3]"
            tag={
              <Tag className="bg-[var(--feed-digest-weak)] text-[var(--content-default)]">
                Current Plan
              </Tag>
            }
            specs={currentSpecs}
          />
          <RecommendedUpgrade
            packages={packages}
            proPlan={proPlan}
            currentKey={currentKey}
            isProUser={currentPlan.id !== "base"}
            canChangePackage={canChangePackage}
            relation={switchRelation}
            onManage={onManage}
            onTierUpgraded={onTierUpgraded}
          />
        </div>
      </div>
    </Card>
  );
}
