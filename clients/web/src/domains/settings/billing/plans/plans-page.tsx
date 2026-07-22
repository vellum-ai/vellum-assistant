import { ArrowLeft, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  PACKAGE_ORDER,
  type ProPackage,
  tierRelation,
} from "@/domains/settings/billing/package-types";
import { FREE_STORAGE_GIB } from "@/domains/settings/billing/plan-tier-meta";
import {
  CustomPlanModal,
  type CustomPlanSelection,
} from "@/domains/settings/billing/plans/custom-plan-modal";
import { CustomPlanRow } from "@/domains/settings/billing/plans/custom-plan-row";
import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import { PlanColumnCard } from "@/domains/settings/billing/plans/plan-column-card";
import {
  downgradeLabel,
  getPlanTierCopy,
} from "@/domains/settings/billing/plans/plans-copy";
import { useChangePackage } from "@/domains/settings/billing/use-change-package";
import {
  extractMutationError,
  isPackageSwitchEligible,
} from "@/domains/settings/components/adjust-plan-utils";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import { formatDollars } from "@/domains/settings/components/tier-pricing";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
  organizationsBillingSubscriptionUpgradeCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  MachineSizeEnum,
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
import { SIZE_LABEL } from "@/lib/billing/machine-sizes";
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
  `${FREE_STORAGE_GIB} GiB Storage`,
  "Pay-as-you-go credits",
];

/** "$50/month" (or "$0/month"). */
function priceLabelFromCents(cents: number): string {
  return `${formatDollars(cents)}/month`;
}

/** Machine label for a package's feature row, e.g. "Medium Computer". */
function machineComputerLabel(pkg: ProPackage): string {
  const size = pkg.machine_size;
  const label = size ? (SIZE_LABEL[size as MachineSizeEnum] ?? size) : "Small";
  return `${label} Computer`;
}

/** Catalog-derived feature rows, plus any static extras from the copy. */
function packageFeatures(pkg: ProPackage, extra: readonly string[]): string[] {
  const credits = pkg.credits_usd ?? 0;
  return [
    machineComputerLabel(pkg),
    `${pkg.storage_gib} GiB Storage`,
    `${formatDollars(credits * 100)} in credits per month`,
    ...extra,
  ];
}

/**
 * Full-screen "View Plans" pricing takeover at `/assistant/plans`. Always dark
 * regardless of the app theme; the "Super" column flips back to light within
 * its own theme scope. Renders from the live plan catalog — with the
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
  const [pending, setPending] = useState(false);
  const [customPlanOpen, setCustomPlanOpen] = useState(false);
  // The package a Pro user is switching to, awaiting reconfirm; null when the
  // dialog is closed.
  const [switchTarget, setSwitchTarget] = useState<ProPackage | null>(null);
  // Reveals the in-tab provisioning takeover after a successful switch — the
  // same `TierUpgradeResizeModal` surface the tier-change flow opens via
  // `onTierUpgraded` (see billing-page.tsx), reused here rather than reinvented.
  const [resizeTakeoverOpen, setResizeTakeoverOpen] = useState(false);

  const subscription = subscriptionQuery.data;
  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );
  const packages = proPlan?.packages ?? [];
  const hasPackages = packages.length > 0;

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
    const isProUser = subscription.plan_id === "pro";
    const currentTierKey =
      subscription.plan_id === "base"
        ? "free"
        : (subscription.package?.key ?? null);

    const selectTier = (tierKey: string) => {
      if (isProUser) {
        if (tierKey === "free") {
          // Pro → Free is a subscription cancellation, not a package switch;
          // route to the billing manage/cancel surface rather than the
          // (package-only) change-package endpoint, which 400s on non-package
          // keys.
          navigate(`${routes.settings.usage}?tab=billing&adjust_plan`);
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
        // Only a clean packaged Pro sub can switch in place. A customized,
        // cancelling, or non-entitlement-status sub can't — route it to the
        // billing manage/cancel surface instead of posting a change-package that
        // can only fail (the same fallback the Pro → Free case uses).
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

    const confirmSwitch = async () => {
      if (!switchTarget) {
        return;
      }
      const result = await changePackage(switchTarget.key);
      if (!result) {
        // The hook already toasted; keep the confirm dialog open so the user
        // can retry.
        return;
      }
      setSwitchTarget(null);
      if (result.status === "ok") {
        // The switch applied; reveal the provisioning takeover so the user can
        // resize into the new tier.
        setResizeTakeoverOpen(true);
      } else {
        // no_op: already on this package — nothing to provision.
        toast.success("You're already on this plan.");
      }
    };

    const switchRelation = switchTarget
      ? tierRelation(currentTierKey, switchTarget.key)
      : "upgrade";

    const startCustomCheckout = (selection: CustomPlanSelection) =>
      startCheckout({
        target_plan_id: "pro",
        confirm: true,
        machine_tier: selection.machineTier,
        storage_tier: selection.storageTier,
        credit_tier: selection.creditTier,
      });

    const handleConfigure = () => {
      if (isProUser) {
        // Same rule as the plan-card CTAs: the upgrade endpoint no-ops for an
        // active Pro org, so plan changes go through the manage-plan modal.
        navigate(`${routes.settings.usage}?tab=billing&adjust_plan`);
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
    const freeRelation = tierRelation(currentTierKey, "free");

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
            Plans designed to empower you
          </h1>
          <p className="text-[20px] font-medium text-[var(--content-tertiary)]">
            Start free. Upgrade when you actually need more.
          </p>
        </header>

        {/* Shrinks the four columns to fit as the viewport narrows, reflowing
            to two-up then one-up; `items-start` keeps each card at its content
            height so the four-feature Super/Ultra cards stay taller. */}
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
            pending={pending || changePackagePending}
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
                mostPopular={copy?.mostPopular}
                tone={copy?.mostPopular ? "light" : "dark"}
                isCurrent={currentTierKey === pkg.key}
                intent={relation}
                pending={pending || changePackagePending}
                onCta={() => selectTier(pkg.key)}
              />
            );
          })}
        </div>

        <CustomPlanRow className="mt-10" onConfigure={handleConfigure} />

        <CustomPlanModal
          open={customPlanOpen}
          proPlan={proPlan}
          pending={pending}
          onClose={() => setCustomPlanOpen(false)}
          onContinue={(selection) => void startCustomCheckout(selection)}
        />

        <PackageSwitchConfirmModal
          open={switchTarget !== null}
          relation={switchRelation === "downgrade" ? "downgrade" : "upgrade"}
          packageName={switchTarget?.name ?? ""}
          pending={changePackagePending}
          onCancel={() => setSwitchTarget(null)}
          onConfirm={() => void confirmSwitch()}
        />

        <TierUpgradeResizeModal
          open={resizeTakeoverOpen}
          onClose={() => setResizeTakeoverOpen(false)}
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
