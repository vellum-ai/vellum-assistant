import { ArrowLeft, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AndroidBillingGate } from "@/domains/settings/billing/android-billing-gate";
import {
  isCleanPin,
  PACKAGE_ORDER,
  type ProPackage,
  type SwitchRelation,
  tierRelation,
} from "@/domains/settings/billing/package-types";
import {
  currentTierRows,
  machineLabel,
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
import { PRICING_DOCS_URL } from "@/domains/settings/billing/plans/docs-links";
import { FreeDowngradeConfirmModal } from "@/domains/settings/billing/plans/free-downgrade-confirm-modal";
import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import { PlanColumnCard } from "@/domains/settings/billing/plans/plan-column-card";
import {
  getPlanTierCopy,
} from "@/domains/settings/billing/plans/plans-copy";
import { Trans, useTranslation } from "@/i18n";
import {
  BillingOnboardingModal,
  type ResizeTakeoverContext,
} from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import type { TakeoverDirection } from "@/domains/settings/billing/pro-onboarding/takeover-copy";
import { captureTakeoverAvatarStash } from "@/lib/billing/takeover-avatar-stash";
import { usePreferredOrActiveAssistant } from "@/domains/settings/billing/pro-onboarding/use-preferred-or-active-assistant";
import { useChangePackage } from "@/domains/settings/billing/use-change-package";
import { useChangeTiers } from "@/domains/settings/billing/use-change-tiers";
import { useCheckoutDismissRefresh } from "@/domains/settings/billing/use-checkout-dismiss-refresh";
import {
  extractMutationError,
  isPackageSwitchEligible,
} from "@/domains/settings/components/adjust-plan-utils";
import {
  formatDollars,
  priceLabelFromCents,
} from "@/domains/settings/components/tier-pricing";
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
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { lowersMachineCeiling } from "@/lib/billing/machine-sizes";
import { openUrl } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { PACKAGE_PARAM, routes } from "@/utils/routes";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

// Near-black takeover canvas. No surface token holds this value — the darkest
// dark-theme surface is `--surface-base` (#17191C) — so the raw hex stands.
const PAGE_BACKGROUND = "#0A0A0B";

// How long the `?package=` deep link waits for its forced re-read of the
// billing data before deciding on whatever the cache already holds.
const DEEP_LINK_REFRESH_TIMEOUT_MS = 8_000;

// How the takeover describes a package switch. The neutral "switch" relation is
// a Custom sub, which has no catalog rank to compare against the target, so its
// move has no knowable direction and the copy must not claim one.
const TAKEOVER_DIRECTION: Record<SwitchRelation, TakeoverDirection> = {
  upgrade: "upgrade",
  downgrade: "downgrade",
  switch: "change",
};

// The screen is a wall of creature avatars; warm the bundled component chunk at
// module load so they resolve before first paint instead of popping in.
preloadBundledAvatarComponents();

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

/** Machine label for a package's feature row, e.g. "Medium Computer". */
function machineComputerLabel(
  pkg: ProPackage,
  translate: SettingsTranslate,
): string {
  return translate("plansPage.featureComputer", {
    machine: machineLabel(pkg),
  });
}

/** Catalog-derived feature rows, plus any static extras from the copy. */
function packageFeatures(
  pkg: ProPackage,
  extra: readonly string[],
  translate: SettingsTranslate,
): string[] {
  const credits = pkg.credits_usd ?? FREE_CREDITS_USD;
  return [
    machineComputerLabel(pkg, translate),
    translate("plansPage.featureStorage", { gib: pkg.storage_gib }),
    translate("plansPage.featureCreditsIncluded", {
      amount: formatDollars(credits * 100),
    }),
    ...extra,
  ];
}

/**
 * A one-line recap of a custom sub's current tiers for the Custom row, e.g.
 * "Medium Machine · 30 GB · 50 credits". Row wording is shared with the
 * adjust-plan modal's current-plan card via `currentTierRows`.
 */
function customCurrentSummary(current: CurrentTiers, proPlan: ProPlan): string {
  return currentTierRows(current, proPlan).join(" · ");
}

/**
 * Full-screen "View Plans" pricing takeover at `/assistant/plans`. Always dark
 * regardless of the app theme; the recommended column flips back to light
 * within its own theme scope. Renders from the live plan catalog — with the
 * `pro-packages` flag off the catalog is empty and the route bounces back to
 * the billing page.
 */
function PlansPageContent() {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
    currentKnown,
    primaryAssistantId,
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
  // What the plan looked like before the in-place change this takeover is
  // watching. Captured pre-dispatch, because every read here reports the applied
  // change once it returns. See `ResizeTakeoverContext`.
  const [resizeContext, setResizeContext] = useState<
    ResizeTakeoverContext | undefined
  >(undefined);
  // `?package=<key>` is a one-shot deep link (from marketing / the checkout
  // no-op bail); once acted on it must never re-fire.
  const packageParamConsumedRef = useRef(false);
  // Whether the billing reads the deep link decides from have been re-read
  // from the server, or the bounded wait for that re-read has run out.
  const [billingReadsRefreshed, setBillingReadsRefreshed] = useState(false);
  const billingRefreshStartedRef = useRef(false);
  // The requested package, held from the moment the param is stripped until
  // the stripped URL commits. See the deep-link effects below.
  const [pendingPackage, setPendingPackage] = useState<string | null>(null);

  const subscription = subscriptionQuery.data;
  const proPlan = plansQuery.data?.plans.find(
    (p): p is ProPlan => p.id === "pro",
  );
  const packages = proPlan?.packages ?? [];
  const hasPackages = packages.length > 0;
  const isProUser = subscription?.plan_id === "pro";

  // The pod whose `machine_size` an in-place change moves, resolved the way the
  // takeover resolves the assistant it watches: the onboarding payload's primary
  // when it names one, else the active assistant. Both sides of a machine chip
  // must describe the same machine in a multi-assistant org. The real size is
  // what makes that chip honest: a cap that finds the pod already at or below
  // the new ceiling skips it and creates no resize marker, so a ceiling-derived
  // from-side would draw a downsize that never runs.
  //
  // Held until `currentKnown`, because `primaryAssistantId` rides the same
  // onboarding read. Asking earlier resolves a null id to the ACTIVE assistant,
  // which is a different pod in a multi-assistant org, and that real-but-wrong
  // size is what the takeover would then state for the life of the change. A
  // read that failed or went stale names a primary just as confidently, so
  // settling is not enough; the payload has to be one worth believing.
  //
  // When it is not, the from-sides stay null, which the takeover resolves per
  // dimension and the chips drop. A missing chip beats one describing another
  // machine. Nothing the user clicks waits on this: a plan change must not
  // depend on an assistant read.
  //
  // Discarding the value is the gate, not disabling the query. Disabling stops
  // a fetch but leaves whatever the cache already holds, and a null primary
  // makes the hook answer with the active assistant, so the pod it names is
  // precisely the wrong one in the org where this matters.
  const orgReady = useIsOrgReady();
  const resolvedAssistant = usePreferredOrActiveAssistant(
    primaryAssistantId,
    platformReady && orgReady && isProUser && currentKnown,
  );
  const assistant = currentKnown ? resolvedAssistant : undefined;

  // A Custom sub (unpinned or customized) has no meaningful catalog rank, so
  // it has no current tier: every named card is offered as a switch target —
  // including a customized sub's own pinned key, which is a real
  // revert-to-stock operation.
  const currentTierKey = !subscription
    ? null
    : subscription.plan_id === "base"
      ? "free"
      : isCleanPin(subscription.package)
        ? subscription.package.key
        : null;

  // Pro → Free is a cancellation: after a confirm step it opens the Stripe
  // billing portal (the same destination as the adjust-plan modal's "Downgrade
  // to Base") so the user can cancel there. Snapshot the pre-redirect state for
  // the post-return toast.
  const portalMutation = useBillingPortalSession(
    buildPortalReturnSnapshot(subscription),
  );

  // Pro features lost by downgrading to Free — the confirm dialog lists these.
  const baseFeatureSet = new Set(
    plansQuery.data?.plans.find((p) => p.id === "base")?.included_features ??
      [],
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

  // `?package=<key>` is the one-shot deep link; it is live until the effects
  // below strip it.
  const packageParam = searchParams.get(PACKAGE_PARAM);

  // The takeover only makes sense against a platform-hosted assistant with a
  // live package catalog. Anything else — self-hosted or no platform session,
  // an empty catalog (the `pro-packages` flag off), or a subscription we can't
  // read — has nothing to show, so fall back to the billing page.
  const notPlatformHosted = !platformReady && !platformResolving;
  const catalogEmpty = platformReady && !plansQuery.isLoading && !hasPackages;
  // An unconsumed deep link has asked for both billing reads again, so the two
  // read-derived bails are answers to a question already being re-asked: a
  // catalog that reads empty (flag flipped on since) or a subscription that
  // reads failed can both come back resolvable. Hold them until that re-read
  // settles. Hosting is not something a refetch can change, so it still bails
  // on sight.
  const deepLinkAwaitingReads = packageParam != null && !billingReadsRefreshed;
  const cannotResolve =
    notPlatformHosted ||
    (!deepLinkAwaitingReads && (subscriptionQuery.isError || catalogEmpty));
  useEffect(() => {
    if (cannotResolve) {
      // Platform-hosted but catalog-empty (pro-packages off) or a failed
      // subscription read still has an upgrade path via the billing adjust-plan
      // modal; self-hosted / no session does not.
      const target = notPlatformHosted
        ? routes.settings.usageBilling
        : `${routes.settings.usageBilling}&adjust_plan`;
      navigate(target, { replace: true });
    }
  }, [cannotResolve, notPlatformHosted, navigate]);

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
        captureTakeoverAvatarStash(queryClient);
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
          t("plansPage.checkoutFailedToast"),
        ),
      );
    } finally {
      setPending(false);
    }
  };

  // `replaceOnBail` replaces the current history entry when routing to the
  // billing manage surface instead of pushing. The deep link sets it so the
  // consumed `?package=` URL leaves no live entry behind for Back to land on.
  const selectTier = (
    tierKey: string,
    options?: { replaceOnBail?: boolean },
  ) => {
    if (!subscription) {
      return;
    }
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
        navigate(`${routes.settings.usageBilling}&adjust_plan`, {
          replace: options?.replaceOnBail === true,
        });
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

  // The deep-link effects below act at most once, so they read the handler
  // through a ref rather than depending on an identity that changes every
  // render.
  const selectTierRef = useRef(selectTier);
  useEffect(() => {
    selectTierRef.current = selectTier;
  });

  // `?package=<key>` opens the switch flow for the requested package exactly
  // once, reusing `selectTier` so the deep link inherits every guard a click
  // gets. Non-Pro users get no checkout from a URL, and `free` names a
  // cancellation rather than a package — but the param is dropped either way so
  // it can't fire later once they are Pro.
  //
  // Both reads answer off the cache the moment the page mounts, and
  // `staleTime` can keep them from refetching at all — so the one-shot link
  // would be spent on whatever was true the last time anything asked. The
  // checkout `no_op` bail is the case that makes this load-bearing: it routes
  // here *because* the account is already Pro, and a subscription cached from
  // before that reads Base, which drops the package instead of opening the
  // switch. Re-read both, and let the effect below decide on the answer.
  useEffect(() => {
    if (packageParam == null || packageParamConsumedRef.current) {
      return;
    }
    if (cannotResolve || !platformReady || billingRefreshStartedRef.current) {
      return;
    }
    billingRefreshStartedRef.current = true;
    // A read that never answers decides on the cache instead of holding the
    // link open forever. The bound owns no effect cleanup: the body runs once
    // for the page's life, so a cleanup — including StrictMode's simulated one
    // — would drop the bound and leave nothing to fall back on.
    const bound = setTimeout(() => {
      setBillingReadsRefreshed(true);
    }, DEEP_LINK_REFRESH_TIMEOUT_MS);
    const settle = () => {
      clearTimeout(bound);
      setBillingReadsRefreshed(true);
    };
    void Promise.all([
      queryClient.refetchQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      }),
      queryClient.refetchQueries({
        queryKey: organizationsBillingPlansRetrieveQueryKey(),
      }),
    ]).then(settle, settle);
  }, [cannotResolve, packageParam, platformReady, queryClient]);

  useEffect(() => {
    if (packageParam == null || packageParamConsumedRef.current) {
      return;
    }
    // The redirect effect above is already navigating away this tick. Stripping
    // now would abort it, and its deps never change again, so it would never
    // re-fire — stranding the user on the spinner.
    //
    // Refreshed means the re-read finished or its bound elapsed, not that it
    // succeeded: a failed refetch leaves the cache it was meant to replace
    // sitting right there, and deciding from that is what keeps the link from
    // going inert — no modal, no redirect, param never dropped.
    if (cannotResolve || !platformReady || !billingReadsRefreshed) {
      return;
    }
    packageParamConsumedRef.current = true;
    if (isProUser && packageParam !== "free") {
      setPendingPackage(packageParam);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(PACKAGE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [
    billingReadsRefreshed,
    cannotResolve,
    packageParam,
    platformReady,
    isProUser,
    setSearchParams,
  ]);

  // The strip above is a router navigation, and `selectTier` may start another
  // one. Two navigations in the same tick abort each other — with middleware on
  // the route tree the strip always loses — so wait for the stripped URL to
  // commit before acting on the held key.
  useEffect(() => {
    if (pendingPackage == null || packageParam != null) {
      return;
    }
    setPendingPackage(null);
    selectTierRef.current(pendingPackage, { replaceOnBail: true });
  }, [packageParam, pendingPackage]);

  let body: ReactNode;
  if (subscription && proPlan && hasPackages) {
    // A Pro sub with no clean pin (unpinned, customized, or legacy) — exactly
    // the subs `currentTierKey` leaves null — is represented by the Custom row,
    // not any named card. Mark that row as their current plan and summarize its
    // tiers, once the current tiers have loaded.
    const isCustomCurrent = isProUser && currentTierKey === null;
    // Mark the row current only once the real current tiers have loaded.
    // `currentReady` also flips true when the onboarding read settles with an
    // error (tiers null), so require the provisioned storage as the loaded
    // signal — otherwise the row is marked current next to a degraded summary.
    const showCurrentPlan =
      isCustomCurrent && currentReady && current.storageGib != null;
    const currentSummary = showCurrentPlan
      ? customCurrentSummary(current, proPlan)
      : undefined;

    // Confirmed Pro → Free cancellation: close the confirm and hand off to the
    // Stripe billing portal, where the actual cancellation happens.
    const confirmFreeDowngrade = () => {
      setFreeDowngradeOpen(false);
      portalMutation.mutate({});
    };

    /**
     * The plan's from-sides as they stand at the moment of the call. Both
     * in-place paths take this BEFORE they dispatch: the server caps the machine
     * before it answers and the mutation hooks then invalidate the subscription
     * and onboarding queries `current` derives from, so every read afterwards
     * reports the change that just landed.
     *
     * Both resource dimensions come off the assistant rather than the billed
     * tiers, which is what the takeover compares them against. A volume never
     * shrinks, so an org that lowered its storage tier keeps the larger disk
     * while `selected_storage_gib` reports the smaller billed one: raising the
     * tier again would draw a move from a size the disk left long ago, and a
     * raise that stays under the retained size would draw a growth that never
     * happens.
     */
    const capturePlanBefore = () => ({
      creditTier: current.creditTier,
      fromSnapshot: {
        machineSize: assistant?.machine_size ?? null,
        storageGib: assistant?.provisioned_storage_gib ?? null,
      },
    });

    // A Custom sub (currentTierKey null) can't be ranked against the target, so
    // it stays direction-neutral ("switch"); a clean-pinned sub gets the
    // directional up/down relation. Drives the confirm copy and, once
    // confirmed, the takeover's.
    const switchRelation: SwitchRelation = switchTarget
      ? currentTierKey === null
        ? "switch"
        : tierRelation(currentTierKey, switchTarget.key) === "downgrade"
          ? "downgrade"
          : "upgrade"
      : "upgrade";

    const confirmSwitch = async () => {
      if (!switchTarget) {
        return;
      }
      const target = switchTarget;
      const before = capturePlanBefore();
      // Whether the switch can cap the pod's machine down, which is what
      // decides if targets that read met can stand in for "nothing was owed".
      // Only the machine ceiling moves that way: a volume never shrinks, and
      // credits are not a provisioned resource at all.
      //
      // A Custom sub has no catalog rank, so its own ceiling can sit anywhere
      // relative to the target's, and an unranked ceiling can't be compared at
      // all. Neither may claim the fast inference. `currentKnown` is what
      // separates a tier that is absent from one that was never read: a failed
      // onboarding read settles `currentReady` while leaving `machineTier`
      // null, which is indistinguishable from a package that names no machine
      // and would rank an Ultra sub as if it sat on the floor.
      const canLowerResources =
        currentTierKey === null ||
        !currentReady ||
        !currentKnown ||
        lowersMachineCeiling(current.machineTier, target.machine_tier);
      const result = await changePackage(target.key);
      if (!result) {
        // The hook already toasted; keep the confirm dialog open so the user
        // can retry.
        return;
      }
      setSwitchTarget(null);
      if (result.status === "no_op") {
        // Already on this package — nothing to provision.
        toast.success(t("plansPage.alreadyOnPlanToast"));
        return;
      }
      // status === "ok": every direction restarts the pod, a downgrade included
      // (the server caps the machine down and the resize rolls out from there),
      // so all of them watch the provisioning takeover. The direction only
      // steers the copy.
      const toCreditTier = (target.credit_tier ??
        null) as CreditTierEnum | null;
      setResizeContext({
        fromSnapshot: before.fromSnapshot,
        credits:
          toCreditTier !== before.creditTier
            ? { fromTier: before.creditTier, toTier: toCreditTier }
            : null,
        direction: TAKEOVER_DIRECTION[switchRelation],
        canLowerResources,
      });
      setResizeTakeoverOpen(true);
    };

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
      const before = capturePlanBefore();
      // The modal seeds from `current`, so the machine tier it is moving away
      // from is read here rather than guessed. A credit-only or storage-only
      // edit leaves the ceiling alone and keeps its fast no-op inference, while
      // a tier that was never read cannot be ranked and so cannot claim it.
      const canLowerResources =
        !currentKnown ||
        lowersMachineCeiling(current.machineTier, selection.machineTier);
      const result = await changeTiers(selection);
      if (!result) {
        // The hook toasted; keep the modal open so the user can retry.
        return;
      }
      setCustomPlanOpen(false);
      if (result.needsResize || result.creditChanged) {
        // Both a resize and a credit-only change open the takeover; thread the
        // tier move only when credits actually changed.
        setResizeContext({
          fromSnapshot: before.fromSnapshot,
          credits: result.creditChanged
            ? { fromTier: before.creditTier, toTier: selection.creditTier }
            : null,
          // A per-dimension edit can raise one dimension and lower another, so
          // it has no single direction to state.
          direction: "change",
          canLowerResources,
        });
        setResizeTakeoverOpen(true);
      } else {
        toast.success(t("plansPage.planUpdatedToast"));
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

    const freeFeatures = [
      t("plansPage.freeFeatureSmallComputer"),
      t("plansPage.freeFeatureStorage", { gib: FREE_STORAGE_GIB }),
      t("plansPage.freeFeaturePayAsYouGo"),
    ];

    body = (
      <div className="my-auto flex w-full flex-col items-center">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1
            className="text-[40px] text-[var(--content-emphasised)] sm:text-[60px]"
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: "1.2px",
            }}
          >
            {t("plansPage.heading")}
          </h1>
          <p className="text-[20px] font-medium text-[var(--content-tertiary)]">
            {t("plansPage.subheading")}
          </p>
        </header>

        {/* Shrinks the four columns to fit as the viewport narrows, reflowing
            to two-up then one-up; `items-start` keeps each card at its natural
            content height, so the four-feature Super/Ultra columns are taller
            than the featured Mighty column. */}
        <div className="mt-6 grid w-full max-w-[1312px] grid-cols-1 items-start gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
          <PlanColumnCard
            tierKey="free"
            name="Base"
            tagline={freeCopy?.tagline ?? ""}
            priceLabel={t("plansPage.freePriceLabel")}
            priceCaption={freeCopy?.priceCaption ?? t("plansPage.foreverCaption")}
            ctaLabel={
              freeRelation === "downgrade"
                ? t("plansPage.downgradeTo", { name: "Base" })
                : (freeCopy?.cta ?? t("plansPage.startFreeCta"))
            }
            features={freeFeatures}
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
                priceCaption={
                  copy?.priceCaption ?? t("plansPage.billedMonthlyCaption")
                }
                ctaLabel={
                  relation === "downgrade"
                    ? t("plansPage.downgradeTo", { name: pkg.name })
                    : (copy?.cta ?? pkg.name)
                }
                features={packageFeatures(pkg, copy?.extraFeatures ?? [], t)}
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
          className="mt-6 sm:mt-10"
          onConfigure={handleConfigure}
          configureDisabled={
            (isProUser && !currentReady) || billingActionPending
          }
          isCurrent={showCurrentPlan}
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
          targetPackage={switchTarget}
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
            // Fail-safe: drop the captured context so stale chips can't
            // resurface if an open path forgot to set it.
            setResizeContext(undefined);
          }}
          resizeContext={resizeContext}
        />

        <p className="mt-6 text-center text-[12px] font-medium text-[var(--content-tertiary)] sm:mt-10">
          <Trans
            ns="settings"
            i18nKey="plansPage.cancelAnytimeFooter"
            components={{
              docsLink: (
                <a
                  href={PRICING_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--content-default)] underline"
                />
              ),
            }}
          />
        </p>
      </div>
    );
  } else {
    body = (
      <div className="my-auto flex items-center justify-center">
        <Loader2
          className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
          aria-label={t("plansPage.loadingPlansAriaLabel")}
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
          {t("plansPage.back")}
        </Button>
      </div>

      <div
        className="plans-takeover-content-enter flex min-h-full flex-col items-center px-4 pb-8 sm:px-6"
        style={{ paddingTop: electron ? "5rem" : "4rem" }}
      >
        {body}
      </div>
    </div>
  );
}

export function PlansPage() {
  return (
    <AndroidBillingGate redirectToBilling>
      <PlansPageContent />
    </AndroidBillingGate>
  );
}
