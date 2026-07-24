import { ArrowUp, Loader2, Sparkles } from "lucide-react";

import { useState } from "react";

import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  isCleanPin,
  nextPackageUp,
  proPackageDisplayName,
  type ProPackage,
  type SwitchRelation,
} from "@/domains/settings/billing/package-types";
import { useChangePackage } from "@/domains/settings/billing/use-change-package";
import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import {
  machineLabel,
  packageSpecs,
  type PlanSpec,
} from "@/domains/settings/billing/plan-spec";
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
import { formatMonthly } from "./tier-pricing";

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

const DEFAULT_DISPLAY: PlanDisplay = PLAN_DISPLAY.base;

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
   * How the target package relates to the current sub — drives the confirm
   * copy. A clean pin's next package is an "upgrade"; a customized or unpinned
   * (Custom) sub gets the direction-neutral "switch".
   */
  relation: SwitchRelation;
  /**
   * Manage-path delegate (AdjustPlanModal). Handles a cancelling or
   * non-entitlement Pro sub that the change-package flow cannot switch, and the
   * empty-catalog fallback.
   */
  onManage: () => void;
  /**
   * Opens the provisioning takeover (resize modal) after a Pro user's in-place
   * package change succeeds — the same signal the tier-change flow raises.
   */
  onTierUpgraded?: () => void;
}

function RecommendedUpgrade({
  packages,
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
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Native iOS keeps Checkout inside an in-app sheet; refetch when it closes.
  useCheckoutDismissRefresh();

  const recommended = nextPackageUp(packages, currentKey);
  if (!recommended) {
    return null;
  }

  const currentPackage = currentKey
    ? (packages.find((p) => p.key === currentKey) ?? null)
    : null;
  // "a stronger machine" only holds when the recommended tier's machine size
  // actually steps up. Free→Mighty stays on the Small baseline (machine_size
  // null), so only credits and storage increase there — drop the machine clause.
  const machineUpgrades =
    machineLabel(currentPackage) !== machineLabel(recommended);
  const summarySpecs: PlanSpec[] = [
    {
      icon: ArrowUp,
      label: machineUpgrades
        ? "more credits, storage, and a stronger machine"
        : "more credits and storage",
      multiline: true,
    },
  ];
  const deltaCents =
    recommended.total_price_cents - (currentPackage?.total_price_cents ?? 0);
  // A Custom (customized or unpinned) sub's real tiers can diverge from any
  // stock package, so the stock price delta and stock resource chips would
  // misstate the direction and size of the change. The neutral "switch"
  // relation drops the delta framing and offers the named plan by itself.
  const isNeutralSwitch = relation === "switch";
  const upgradeLabel = isNeutralSwitch
    ? `Switch to ${recommended.name}`
    : `Upgrade for ${formatMonthly(deltaCents)} more`;
  const isPending = pending || upgradeMutation.isPending || changePending;

  // Pro users change their package in place: confirm the prorated charge, then
  // call change-package and hand off to the resize takeover on success. Base
  // users go through the Stripe-checkout path instead.
  const handleConfirmChange = async () => {
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

  const recommendedCopy = getPlanTierCopy(recommended.key);
  const upgradeButton = (
    <Button
      variant="primary"
      className="shrink-0"
      onClick={handleUpgrade}
      disabled={isPending}
      leftIcon={
        isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined
      }
      data-testid="recommended-upgrade-button"
    >
      {upgradeLabel}
    </Button>
  );
  return (
    <>
      <PlanSpecCard
        tone="dark"
        tierKey={recommended.key}
        name={recommended.name}
        className="lg:flex-[2]"
        tag={
          <Tag
            className="bg-[var(--feed-digest-weak)] text-[var(--credits-accent)]"
            leftIcon={
              <Sparkles className="h-3 w-3 text-[var(--credits-accent)]" />
            }
          >
            {isNeutralSwitch ? "Switch plan" : "Recommended"}
          </Tag>
        }
        tagline={recommendedCopy?.tagline}
        specs={isNeutralSwitch ? null : summarySpecs}
        action={upgradeButton}
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
  // A live packages catalog opens the plans takeover for base and every Pro sub
  // — a clean pin, a customized pin, and an unpinned (legacy Custom) sub alike;
  // the takeover's own CTAs handle each state's transitions. One exception: a
  // custom/unpinned sub that is pending cancellation keeps the manage modal,
  // which surfaces the cancellation state and the "Keep your Plan" action — the
  // takeover can't act on a cancelling sub (every change is rejected), and a
  // clean pin already reaches the manage surface through its package CTA. An
  // empty catalog (the `pro-packages` flag off) has no takeover to open, so
  // Manage falls back to the manage modal.
  const canOpenPlansTakeover =
    packages.length > 0 &&
    (currentPlan.id === "base" ||
      isCleanPin(subscription.package) ||
      !isCancelling);
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

  const currentCopy = getPlanTierCopy(currentTier);
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
  // Tagline shows for a KNOWN plan (free, or a clean stock pin); hidden for a
  // Custom/unknown sub whose real plan can't be named. (Note: this is gated on
  // "known plan", NOT on having chips — free has no chips but a real tagline.)
  const isKnownCurrentPlan = isFreePlan || isCleanPin(subscription.package);

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
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
            tone="light"
            tierKey={currentTier}
            name={planName}
            nameTestId="plan-card-name"
            className="lg:flex-[3]"
            centered={isFreePlan}
            tag={
              <Tag className="bg-[var(--feed-digest-weak)] text-[var(--content-default)]">
                Your Current Plan
              </Tag>
            }
            // The tagline follows "known plan" (free, or a clean stock pin), not
            // "has chips": free is centered with no chips but still shows its
            // real tagline, while a Custom/unknown sub — whose real plan can't be
            // named — hides it to avoid mislabeling a paid sub with stock copy.
            tagline={isKnownCurrentPlan ? currentCopy?.tagline : undefined}
            specs={currentSpecs}
          />
          <RecommendedUpgrade
            packages={packages}
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
