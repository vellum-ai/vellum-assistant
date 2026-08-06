import { Loader2, Sparkles } from "lucide-react";

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
import {
  freePlanSpecs,
  packageSpecs,
} from "@/domains/settings/billing/plan-spec";
import { PlanTile } from "@/domains/settings/billing/plan-tile";
import { captureTakeoverAvatarStash } from "@/lib/billing/takeover-avatar-stash";
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
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { openUrl } from "@/runtime/browser";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import {
  formatDollars,
  priceLabelFromCents,
} from "@/domains/settings/components/tier-pricing";
import {
  extractMutationError,
  isPackageSwitchEligible,
} from "./adjust-plan-utils";

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
   * The current plan's monthly price, for the CTA's delta. Null when no honest
   * total is known (a Custom sub, or a pin the live catalog cannot price),
   * which drops the delta from the label.
   */
  currentPriceCents: number | null;
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
   * package is an "upgrade"; a customized or unpinned (Custom) sub gets
   * "switch", which has no next tile to show.
   */
  relation: SwitchRelation;
  /**
   * Manage-path delegate (AdjustPlanModal). Handles a cancelling or
   * non-entitlement Pro sub that the change-package flow cannot act on.
   */
  onManage: () => void;
  /**
   * Opens the provisioning takeover (resize modal) after a Pro user's in-place
   * package change succeeds. Same signal the tier-change flow raises.
   */
  onTierUpgraded?: () => void;
}

function RecommendedUpgrade({
  packages,
  currentKey,
  currentPriceCents,
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
  // The next tile inverts the app theme: a dark tile on a light app and a light
  // tile on a dark app. Velvet counts as dark-family, so it gets a light tile.
  const inverted = useDocumentTheme() === "light" ? "dark" : "light";
  // Native iOS keeps Checkout inside an in-app sheet; refetch when it closes.
  useCheckoutDismissRefresh();

  const recommended = nextPackageUp(packages, currentKey);

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
        captureTakeoverAvatarStash(queryClient);
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

  // The next tile is offered to base users and to Pro clean pins with a
  // stronger package to step up to. A neutral "switch" (a customized or
  // unpinned sub) is never an upgrade, and a top-of-catalog pin has nothing
  // left to step up to; both hide the tile, and the current tile stretches to
  // fill the row. The customize path lives in the plans takeover.
  if (recommended == null || relation === "switch") {
    return null;
  }

  // Only state a delta we can actually compute: `nextPackageUp` falls back to
  // the first catalog package for a pinned key the live catalog no longer
  // carries, so an unknown current price (or a non-positive delta) drops the
  // amount rather than quoting a wrong one.
  const delta =
    currentPriceCents != null
      ? recommended.total_price_cents - currentPriceCents
      : null;
  const ctaLabel =
    delta != null && delta > 0
      ? `Power Up for +${formatDollars(delta)}/month`
      : "Power Up";

  return (
    <>
      <PlanTile
        theme={inverted}
        testId="plan-tile-next"
        tierKey={recommended.key}
        name={recommended.name}
        tag={
          <Tag
            className="bg-[var(--feed-digest-weak)] text-[var(--credits-accent)]"
            leftIcon={
              <Sparkles className="text-[var(--credits-accent)]" aria-hidden />
            }
          >
            Next Plan
          </Tag>
        }
        specs={packageSpecs(recommended)}
        footer={
          <Button
            variant="primary"
            fullWidth
            tintColor="var(--aux-white)"
            className="h-10 border-transparent bg-[var(--system-positive-strong)] hover:bg-[var(--system-positive-strong)] hover:opacity-90 active:bg-[var(--system-positive-strong)]"
            onClick={() => void handleUpgrade()}
            disabled={isPending}
            leftIcon={
              isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : undefined
            }
            data-testid="recommended-upgrade-button"
          >
            {ctaLabel}
          </Button>
        }
      />
      <PackageSwitchConfirmModal
        open={confirmOpen}
        relation={relation}
        packageName={recommended.name}
        targetPackage={recommended}
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

  const planName =
    currentPlan.id === "pro"
      ? proPackageDisplayName(subscription.package)
      : (currentPlan.name ?? currentPlan.id);

  const isCancelling =
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at);
  const isCanceled = subscription.status === "canceled";
  const cancelDate = getEffectiveCancelDate(subscription);
  const showRenewal =
    !isCancelling && !isCanceled && subscription.current_period_end;
  const showCancellation = isCancelling && !isCanceled && cancelDate;

  const proPlan = plans.find((p): p is ProPlan => p.id === "pro");
  // Empty while the `pro-packages` flag is off, which hides the next tile.
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
  // the CTA falls back to the manage modal.
  const canOpenPlansTakeover =
    packages.length > 0 &&
    (currentPlan.id === "base" ||
      isCleanPin(subscription.package) ||
      isPackageSwitchEligible(subscription));
  // The next tile's one-click switch is offered to any switch-eligible Pro sub
  // (a clean pin, a customized pin, or an unpinned Custom sub), inheriting the
  // shared eligibility gate. The confirm copy adapts to the sub's state via
  // `switchRelation`.
  const canChangePackage = isPackageSwitchEligible(subscription);
  // A base user (Stripe checkout) and a clean-pinned Pro sub both make a real
  // upgrade, so the next tile keeps its directional copy and stock chips. Only a
  // Custom Pro sub — a customized pin or an unpinned legacy sub, whose real
  // tiers can diverge from any stock package — gets the direction-neutral
  // switch, since a stock delta could misstate the change.
  const switchRelation: SwitchRelation =
    currentPlan.id === "base" || isCleanPin(subscription.package)
      ? "upgrade"
      : "switch";

  const isFreePlan = currentPlan.id === "base";
  const pin = subscription.package;
  // Paid chips render only when the sub's stock package specs are known. A
  // clean pin absent from the catalog and a customized/unpinned "Custom" sub
  // show no chips and no price (never fall back to the free baseline, which
  // would mislabel a paid sub). A pin on an older package version degrades the
  // same way: its price and specs are grandfathered at the version the org
  // subscribed under, so today's catalog entry does not describe what they
  // actually pay for.
  const currentPackage =
    !isFreePlan && isCleanPin(pin)
      ? (packages.find((p) => p.key === pin.key && p.version === pin.version) ??
        null)
      : null;
  const currentSpecs = isFreePlan
    ? freePlanSpecs()
    : currentPackage
      ? packageSpecs(currentPackage)
      : null;
  const currentPriceCents = isFreePlan
    ? 0
    : (currentPackage?.total_price_cents ?? null);
  const priceLabel = isFreePlan
    ? "Free Forever"
    : currentPackage
      ? priceLabelFromCents(currentPackage.total_price_cents)
      : null;

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
            variant="outlined"
            onClick={
              canOpenPlansTakeover ? () => navigate(routes.plans) : onManage
            }
            data-testid="plan-card-plans-button"
            className="shrink-0"
          >
            View All Plans
          </Button>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
          <PlanTile
            testId="plan-tile-current"
            tierKey={currentTier}
            name={planName}
            nameTestId="plan-card-name"
            tag={<Tag tone="info">Current</Tag>}
            specs={currentSpecs}
            footer={
              priceLabel ? (
                <div className="flex h-10 items-center border-t border-[var(--border-base)]">
                  <Typography
                    as="span"
                    variant="body-large-default"
                    className="text-[var(--content-tertiary)]"
                    data-testid="plan-card-price"
                  >
                    {priceLabel}
                  </Typography>
                </div>
              ) : undefined
            }
          />
          <RecommendedUpgrade
            packages={packages}
            currentKey={currentKey}
            currentPriceCents={currentPriceCents}
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
