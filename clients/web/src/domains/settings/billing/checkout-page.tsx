import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useMutation } from "@tanstack/react-query";

import { organizationsBillingSubscriptionUpgradeCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useMarketingPricingTakeover } from "@/hooks/use-marketing-pricing-takeover";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { checkoutContinuation } from "@/lib/billing/checkout-continuation";
import {
  clearCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { checkoutReturnTarget } from "@/lib/billing/checkout-return-target";
import { openUrl } from "@/runtime/browser";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

/**
 * How far a checkout attempt has got.
 *
 * - `idle` — mounted, nothing fired.
 * - `running` — the upgrade POST is in flight.
 * - `handed_off` — the package intent is stashed and Stripe is open.
 * - `settled` — terminal: an already-Pro `no_op`, a failed upgrade, or a bail.
 *
 * `handed_off` is the line that matters. Before it, this route owns the stash
 * and a bail clears it; after it, the stash belongs to the post-checkout return
 * trip and nothing here may touch it. Electron and native Capacitor open Stripe
 * without unloading the page, so the route is still mounted to enforce that.
 */
type CheckoutPhase = "idle" | "running" | "handed_off" | "settled";

/**
 * Deep-link checkout entrypoint (`/assistant/checkout?package=<slug>`). The
 * marketing pricing CTAs route a chosen Pro package here — reachable by a
 * brand-new user with no assistant yet, so the route sits outside
 * `ActiveAssistantGate` and is exempted from the resolver's no-assistant funnel
 * redirect. This page fires the subscription-upgrade POST and hands off to
 * Stripe.
 *
 * Flow:
 *   - Missing `package` → back to the plans takeover.
 *   - Gate `"disabled"`/`"gated"` → back to plans (its own gating owns the
 *     messaging).
 *   - `marketing-pricing-takeover` off → back to plans. The flag is the kill
 *     switch over the whole pricing funnel; a marketing link cached from while
 *     it was on still lands somewhere useful. Off landing mid-flight settles the
 *     attempt so the response can't open Stripe behind the switch; off landing
 *     after the hand-off leaves the checkout, and its stash, alone.
 *   - Gate `"full"` → fire the upgrade once and either redirect to Stripe
 *     (`redirect`), fall back to plans (`no_op`, already Pro), or surface a
 *     retryable error. It never dead-ends.
 *
 * Every "no purchase happens here" exit honors the `continue` param when one is
 * present (see `checkout-continuation`), so a caller mid-flow — onboarding —
 * gets back to its own next step instead of the plans takeover.
 */
export function CheckoutPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const packageKey = searchParams.get("package") ?? "";
  // Default (session-only) gate: a signed-in platform session reads `"full"`
  // even without an active assistant. See `use-platform-gate.ts`.
  const gate = usePlatformGate();
  // The request interceptor reads `Vellum-Organization-Id` from the org store,
  // which hydrates asynchronously after auth. On a cold deep link the platform
  // session can settle before the org id lands, so gate the fire on this too.
  const isOrgReady = useIsOrgReady();
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
    bailTarget === routes.plans ? "View plans" : "Continue setup";

  const { mutateAsync } = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const [failed, setFailed] = useState(false);
  // StrictMode double-invokes mount effects; the phase gates the upgrade to one
  // fire. It is also how a bail and an in-flight upgrade agree on who won: the
  // bail settles the attempt, and the continuation below drops a result that
  // arrives after that.
  const phaseRef = useRef<CheckoutPhase>("idle");

  const runCheckout = useCallback(async () => {
    phaseRef.current = "running";
    setFailed(false);
    try {
      const result = await mutateAsync({
        body: {
          target_plan_id: "pro",
          package: packageKey,
          confirm: true,
          return_target: checkoutReturnTarget(),
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
        // the purchased package before the subscribe webhook lands.
        saveCheckoutIntent({ kind: "package", packageKey });
        void openUrl(result.checkout_url);
        return;
      }
      // `no_op` — already Pro, nothing to provision. Clear the marked stash so
      // an already-Pro bounce doesn't leave it lingering for its TTL, then hand
      // off rather than stranding the user on a blank splash.
      phaseRef.current = "settled";
      clearCheckoutIntent();
      navigate(bailTarget, { replace: true });
    } catch {
      if (phaseRef.current !== "running") {
        return;
      }
      phaseRef.current = "settled";
      setFailed(true);
    }
  }, [bailTarget, mutateAsync, navigate, packageKey]);

  useEffect(() => {
    // No package to check out, a session that can't reach checkout, or the
    // pricing funnel switched off: fall back to the continuation, or to the
    // plans takeover, which owns its own gating and messaging.
    if (
      !packageKey ||
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
      // no-op, so a response landing after this can't open Stripe.
      phaseRef.current = "settled";
      if (takeover === "disabled") {
        // The kill switch is decisive: the carried package is dead. Drop the
        // stash so it can't resurface on a later provisioning surface within
        // its TTL.
        clearCheckoutIntent();
      }
      navigate(bailTarget, { replace: true });
      return;
    }
    // Hold until the funnel flag resolves, the platform gate is full, AND the
    // org store is ready. Firing before the org id hydrates sends a header-less
    // request that fails; the "Preparing checkout…" spinner keeps showing meanwhile.
    if (
      takeover !== "enabled" ||
      gate !== "full" ||
      !isOrgReady ||
      phaseRef.current !== "idle"
    ) {
      return;
    }
    void runCheckout();
  }, [
    bailTarget,
    gate,
    isOrgReady,
    navigate,
    packageKey,
    runCheckout,
    takeover,
  ]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[var(--content-default)]">
          We couldn&rsquo;t start your checkout. Please try again.
        </p>
        <div className="flex items-center gap-4">
          <Button onClick={() => void runCheckout()}>Try again</Button>
          {/*
           * Taking the escape ends the attempt, so the stash goes with it. A
           * marked signup intent left behind stays readable for its TTL by the
           * provisioning takeover, which ignores the marker — it would render
           * the package as purchased when nothing was bought.
           */}
          <Link
            to={bailTarget}
            onClick={clearCheckoutIntent}
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
        aria-label="Preparing checkout"
      />
      <p className="text-sm text-[var(--content-tertiary)]">
        Preparing checkout&hellip;
      </p>
    </div>
  );
}
