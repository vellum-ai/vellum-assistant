import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  captureTakeoverAvatarStash,
  clearTakeoverAvatarStash,
} from "@/lib/billing/takeover-avatar-stash";
import { organizationsBillingSubscriptionUpgradeCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { useMarketingPricingTakeover } from "@/hooks/use-marketing-pricing-takeover";
import { usePlatformGateWithPending } from "@/hooks/use-platform-gate";
import { checkoutContinuation } from "@/lib/billing/checkout-continuation";
import {
  clearCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { parseCustomCheckoutSelection } from "@/lib/billing/custom-checkout-params";
import { openUrl } from "@/runtime/browser";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { useOrganizationStore } from "@/stores/organization-store";
import { PACKAGE_PARAM, routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

/**
 * How far a checkout attempt has got.
 *
 * - `idle` — mounted, nothing fired.
 * - `running` — the upgrade POST is in flight.
 * - `handed_off` — the package intent is stashed and Stripe is open.
 * - `settled` — terminal: an already-Pro `no_op`, a failed upgrade, or a bail.
 *
 * `handed_off` is the line that matters. Before it, this route owns the stashes
 * and a bail clears them; after it, they belong to the post-checkout return
 * trip and nothing here may touch them. Electron and native Capacitor open
 * Stripe without unloading the page, so the route is still mounted to enforce
 * that, and to offer the way out a browser closed short of paying otherwise
 * leaves the user without.
 */
type CheckoutPhase = "idle" | "running" | "handed_off" | "settled";

/**
 * Drops everything an attempt that never reached Stripe left behind. A retry
 * from the awaiting-return screen re-arms the attempt, so a hand-off followed
 * by a failing retry forfeits the captured avatar on purpose: that path already
 * clears the checkout intent, and the cold return falls back to the breathing
 * placeholder.
 */
function abandonCheckout() {
  clearCheckoutIntent();
  clearTakeoverAvatarStash();
}

/**
 * Deep-link checkout entrypoint (`/assistant/checkout?package=<slug>`, or
 * `?machine_tier=&storage_tier=&credit_tier=` for a custom configuration). The
 * marketing pricing CTAs route a chosen Pro package here — reachable by a
 * brand-new user with no assistant yet, so the route sits outside
 * `ActiveAssistantGate` and is exempted from the resolver's no-assistant funnel
 * redirect. This page fires the subscription-upgrade POST and hands off to
 * Stripe.
 *
 * Flow:
 *   - No package and no valid tier params → back to the plans takeover.
 *   - Gate `"pending"` → hold on the spinner. The platform-session probe has
 *     not answered yet, and a cold reload of this URL is exactly where that
 *     window falls.
 *   - Gate `"disabled"`/`"gated"` → back to plans (its own gating owns the
 *     messaging).
 *   - `marketing-pricing-takeover` off → back to plans. The flag is the kill
 *     switch over the whole pricing funnel; a marketing link cached from while
 *     it was on still lands somewhere useful. Off landing mid-flight settles the
 *     attempt so the response can't open Stripe behind the switch; off landing
 *     after the hand-off leaves the checkout, and its stash, alone.
 *   - Org header still resolving → hold on the spinner; resolution over with no
 *     organization → the retryable error, whose retry re-runs that resolution.
 *   - Gate `"full"` → fire the upgrade once and either redirect to Stripe
 *     (`redirect`), fall back to plans carrying the requested package (`no_op`,
 *     already Pro), or surface a retryable error. It never dead-ends.
 *
 * Every "no purchase happens here" exit honors the `continue` param when one is
 * present (see `checkout-continuation`), so a caller mid-flow — onboarding —
 * gets back to its own next step instead of the plans takeover.
 *
 * On the shells that take the custom-scheme return — Electron's system browser,
 * native Capacitor's `SFSafariViewController` — the hand-off leaves this route
 * mounted behind the browser it opened, and the page it leaves there offers a
 * reopen and an escape. That is the whole story for a checkout the user closes
 * without paying: the return never arrives, so nothing else is coming to move
 * them off this route.
 */
function CheckoutPageContent() {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const packageKey = searchParams.get(PACKAGE_PARAM) ?? "";
  // The package-less encoding of the same funnel: per-dimension tier params.
  // An explicit `package` wins over them, mirroring the mutual exclusion the
  // upgrade serializer enforces on the body they turn into. Memoized because
  // the callbacks below take it as a dependency and `searchParams` is stable
  // for as long as the location is.
  const customSelection = useMemo(
    () => (packageKey ? null : parseCustomCheckoutSelection(searchParams)),
    [packageKey, searchParams],
  );
  // Default (session-only) gate: a signed-in platform session reads `"full"`
  // even without an active assistant. See `use-platform-gate.ts`.
  //
  // The pending-aware variant, because a hard reload of this URL lands while
  // the platform-session probe is still in flight: `sessionStatus` settles
  // ahead of it, so the route is already mounted and reading a session that has
  // not answered yet. Bailing on that would throw away a paid deep link a
  // moment before it becomes valid. `"pending"` is bounded — it decides on
  // `"disabled"` if the probe never lands.
  const gate = usePlatformGateWithPending();
  // The request interceptor reads `Vellum-Organization-Id` from the org store,
  // which hydrates asynchronously after auth. On a cold deep link the platform
  // session can settle before the org id lands, so gate the fire on this too.
  // The tri-state, not the boolean: an id that hasn't arrived yet is worth
  // waiting for, and one that resolution concluded without is not.
  const orgReadiness = useOrgHeaderReadiness();
  // Kill switch over the pricing funnel. `"pending"` until the real flag value
  // lands — the flag defaults off, so redirecting on the cold-load default
  // would bounce every legitimate deep link.
  const takeover = useMarketingPricingTakeover();
  // Where to go when no purchase happens here. Onboarding hands off before the
  // funnel flag has necessarily resolved and passes its own next step, so a
  // pending→disabled transition resumes onboarding instead of stranding a new
  // user on plans, outside the funnel and short of an assistant.
  const bailTarget = checkoutContinuation(searchParams, routes.plans);
  // The escape offered on a failed attempt goes there too, and says so: a
  // carried onboarding continuation is not the plans takeover, and a label
  // naming one destination while taking another is worse than either wording.
  const bailLabel =
    bailTarget === routes.plans
      ? t("checkoutPage.viewPlans")
      : t("checkoutPage.continueSetup");

  const queryClient = useQueryClient();
  const { mutateAsync } = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const [failed, setFailed] = useState(false);
  // Set by a hand-off whose return comes back as a deep link rather than as a
  // page navigation, which is exactly the case where this route survives to
  // render anything at all. Plain web navigates the tab to Stripe, so it stays
  // false there and the render below is the spinner it always was.
  const [awaitingReturn, setAwaitingReturn] = useState(false);
  // StrictMode double-invokes mount effects; the phase gates the upgrade to one
  // fire. It is also how a bail and an in-flight upgrade agree on who won: the
  // bail settles the attempt, and the continuation below drops a result that
  // arrives after that.
  const phaseRef = useRef<CheckoutPhase>("idle");

  const runCheckout = useCallback(async () => {
    phaseRef.current = "running";
    setFailed(false);
    setAwaitingReturn(false);
    const returnTarget = checkoutReturnTarget();
    try {
      const result = await mutateAsync({
        // A package resolves its own line items server-side and is mutually
        // exclusive with the tier fields, so exactly one shape goes out.
        body: customSelection
          ? {
              target_plan_id: "pro",
              confirm: true,
              machine_tier: customSelection.machineTier,
              storage_tier: customSelection.storageTier,
              credit_tier: customSelection.creditTier,
              return_target: returnTarget,
            }
          : {
              target_plan_id: "pro",
              package: packageKey,
              confirm: true,
              return_target: returnTarget,
            },
      });
      if (phaseRef.current !== "running") {
        // A bail settled the attempt while the upgrade was in flight. Drop the
        // result: opening Stripe would defeat the kill switch, and stashing the
        // package would resurrect what the bail cleared. The server may already
        // have minted a Checkout Session — an unvisited one bills nothing and
        // Stripe expires it on its own.
        return;
      }
      if (result.status === "redirect" && result.checkout_url) {
        // Past this point the stash belongs to the return trip, not to this
        // route — see `CheckoutPhase`.
        phaseRef.current = "handed_off";
        // Stash the selection so the post-checkout provisioning screen can show
        // the purchased upgrade before the subscribe webhook lands.
        saveCheckoutIntent(
          customSelection
            ? {
                kind: "custom",
                machineTier: customSelection.machineTier,
                storageTier: customSelection.storageTier,
                creditTier: customSelection.creditTier,
              }
            : { kind: "package", packageKey },
        );
        captureTakeoverAvatarStash(queryClient);
        setAwaitingReturn(returnTarget === "native");
        void openUrl(result.checkout_url);
        return;
      }
      // `no_op` means already Pro, nothing to provision. Clear the stashes so
      // an already-Pro bounce doesn't leave them lingering for their TTL, then
      // hand off rather than stranding the user on a blank splash. Pro→Pro is
      // an in-place package switch, never Stripe Checkout, so the requested
      // package rides along to plans, which opens that switch from it. A
      // carried continuation owns the destination instead — an onboarding
      // resume must not divert into the switch modal. A custom configuration
      // names no package, so it lands on the bail target as it always has:
      // plans has no deep link that reopens a per-dimension configuration.
      phaseRef.current = "settled";
      abandonCheckout();
      navigate(
        bailTarget === routes.plans && packageKey
          ? routes.plansForPackage(packageKey)
          : bailTarget,
        { replace: true },
      );
    } catch {
      if (phaseRef.current !== "running") {
        return;
      }
      phaseRef.current = "settled";
      setFailed(true);
    }
  }, [
    bailTarget,
    customSelection,
    mutateAsync,
    navigate,
    packageKey,
    queryClient,
  ]);

  // The retry the failure and hand-off UIs offer. A failed or abandoned attempt
  // re-runs the upgrade; a missing organization re-runs org resolution instead,
  // since resending a request that still can't name an organization fails the
  // same way. Either path re-arms the attempt, and the effect below fires it
  // once an id lands.
  const retryCheckout = useCallback(() => {
    if (orgReadiness === "ready") {
      void runCheckout();
      return;
    }
    phaseRef.current = "idle";
    setFailed(false);
    setAwaitingReturn(false);
    if (orgReadiness === "unavailable") {
      void useOrganizationStore.getState().fetchOrganizations();
    }
  }, [orgReadiness, runCheckout]);

  useEffect(() => {
    // Nothing to check out (no package and no tier configuration the upgrade
    // endpoint would accept), a session that can't reach checkout, or the
    // pricing funnel switched off: fall back to the continuation, or to the
    // plans takeover, which owns its own gating and messaging.
    if (
      (!packageKey && !customSelection) ||
      gate === "disabled" ||
      gate === "gated" ||
      takeover === "disabled"
    ) {
      if (phaseRef.current === "handed_off") {
        // Checkout is already at Stripe and this route can't unwind it. The
        // stash is what the post-checkout return reads, so leave it — and the
        // route the hand-off left behind — alone.
        return;
      }
      // The attempt is over. Settling it makes an in-flight upgrade's result a
      // no-op, so a response landing after this can't open Stripe. Both stashes
      // go with it whatever ended the attempt: nothing was bought, and a
      // signup-marked intent left readable for its TTL is one the privacy
      // screen resumes checkout from.
      phaseRef.current = "settled";
      abandonCheckout();
      navigate(bailTarget, { replace: true });
      return;
    }
    // Hold until the funnel flag resolves and the platform gate is full (a
    // `"pending"` session lands here). The phase check keeps the branches below
    // to a single attempt, whichever way they decide it.
    if (
      takeover !== "enabled" ||
      gate !== "full" ||
      phaseRef.current !== "idle"
    ) {
      return;
    }
    if (orgReadiness === "resolving") {
      // Firing before the org id hydrates sends a header-less request that
      // fails, and resolution is bounded, so the "Preparing checkout…" spinner
      // keeps showing until it ends one way or the other.
      return;
    }
    if (orgReadiness === "unavailable") {
      // Resolution ended without an id: the header is never arriving on its
      // own, so waiting is waiting forever. Settle into the retry — it re-runs
      // org resolution, and the deep link is still worth completing, which a
      // silent bounce to plans would throw away.
      phaseRef.current = "settled";
      setFailed(true);
      return;
    }
    void runCheckout();
  }, [
    bailTarget,
    customSelection,
    gate,
    navigate,
    orgReadiness,
    packageKey,
    runCheckout,
    takeover,
  ]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[var(--content-default)]">
          {t("checkoutPage.checkoutFailedMessage")}
        </p>
        <div className="flex items-center gap-4">
          <Button onClick={retryCheckout}>{t("checkoutPage.tryAgain")}</Button>
          {/*
           * Taking the escape ends the attempt, so both stashes go with it.
           * Nothing was bought, and a signup-marked intent left behind is one
           * the privacy screen resumes checkout from for the rest of its TTL.
           */}
          <Link
            to={bailTarget}
            onClick={abandonCheckout}
            className="text-sm text-[var(--content-tertiary)] underline"
          >
            {bailLabel}
          </Link>
        </div>
      </div>
    );
  }

  if (awaitingReturn) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[var(--content-default)]">
          {t("checkoutPage.awaitingReturnMessage")}
        </p>
        <div className="flex items-center gap-4">
          <Button onClick={retryCheckout}>
            {t("checkoutPage.reopenCheckout")}
          </Button>
          {/*
           * No `abandonCheckout` here, unlike the failure escape: a
           * checkout that reached Stripe may have been paid for, and this page
           * can't tell. The hand-off already rewrote the stash without the
           * signup marker, so leaving it can only help the return trip — it
           * carries a package name and resumes nothing on its own.
           */}
          <Link
            to={bailTarget}
            className="text-sm text-[var(--content-tertiary)] underline"
          >
            {bailLabel}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <Loader2
        className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
        aria-label={t("checkoutPage.preparingCheckoutAriaLabel")}
      />
      <p className="text-sm text-[var(--content-tertiary)]">
        {t("checkoutPage.preparingCheckout")}
      </p>
    </div>
  );
}

function AndroidCheckoutRedirect() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = checkoutContinuation(
    searchParams,
    routes.settings.usageBilling,
  );

  useEffect(() => {
    abandonCheckout();
    navigate(target, { replace: true });
  }, [navigate, target]);

  return null;
}

export function CheckoutPage() {
  const isNativeAndroid = useIsNativeAndroid();

  return isNativeAndroid ? (
    <AndroidCheckoutRedirect />
  ) : (
    <CheckoutPageContent />
  );
}
