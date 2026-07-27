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
 *     it was on still lands somewhere useful.
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

  const { mutateAsync } = useMutation(
    organizationsBillingSubscriptionUpgradeCreateMutation(),
  );
  const [failed, setFailed] = useState(false);
  // StrictMode double-invokes mount effects; the ref fires the upgrade once.
  const startedRef = useRef(false);

  const runCheckout = useCallback(async () => {
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
      if (result.status === "redirect" && result.checkout_url) {
        // Stash the selection so the post-checkout provisioning screen can show
        // the purchased package before the subscribe webhook lands.
        saveCheckoutIntent({ kind: "package", packageKey });
        void openUrl(result.checkout_url);
        return;
      }
      // `no_op` — already Pro, nothing to provision. Clear the marked stash so
      // an already-Pro bounce doesn't leave it lingering for its TTL, then hand
      // off rather than stranding the user on a blank splash.
      clearCheckoutIntent();
      navigate(bailTarget, { replace: true });
    } catch {
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
      startedRef.current
    ) {
      return;
    }
    startedRef.current = true;
    void runCheckout();
  }, [bailTarget, gate, isOrgReady, navigate, packageKey, runCheckout, takeover]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[var(--content-default)]">
          We couldn&rsquo;t start your checkout. Please try again.
        </p>
        <div className="flex items-center gap-4">
          <Button onClick={() => void runCheckout()}>Try again</Button>
          <Link
            to={routes.plans}
            className="text-sm text-[var(--content-tertiary)] underline"
          >
            View plans
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
