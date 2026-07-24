import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useMutation } from "@tanstack/react-query";

import { organizationsBillingSubscriptionUpgradeCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
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
 *   - Gate `"full"` → fire the upgrade once and either redirect to Stripe
 *     (`redirect`), fall back to plans (`no_op`, already Pro), or surface a
 *     retryable error. It never dead-ends.
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
      // `no_op` — already Pro, nothing to provision. Hand off to the plans
      // takeover rather than stranding the user on a blank splash.
      navigate(routes.plans, { replace: true });
    } catch {
      setFailed(true);
    }
  }, [mutateAsync, navigate, packageKey]);

  useEffect(() => {
    // No package to check out, or a session that can't reach checkout: fall
    // back to the plans takeover, which owns its own gating and messaging.
    if (!packageKey || gate === "disabled" || gate === "gated") {
      navigate(routes.plans, { replace: true });
      return;
    }
    // Hold until the platform gate is full AND the org store is ready. Firing
    // before the org id hydrates sends a header-less request that fails; the
    // "Preparing checkout…" spinner keeps showing meanwhile.
    if (gate !== "full" || !isOrgReady || startedRef.current) {
      return;
    }
    startedRef.current = true;
    void runCheckout();
  }, [gate, isOrgReady, navigate, packageKey, runCheckout]);

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
