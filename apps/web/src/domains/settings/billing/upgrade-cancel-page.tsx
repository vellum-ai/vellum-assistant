import { useEffect } from "react";

import { Navigate, useNavigate } from "react-router";

import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

/**
 * Stripe Checkout `cancel_url` landing page.
 *
 * When a user bails out of the Stripe-hosted upgrade flow, Stripe redirects
 * them here. Stripe does not create a subscription on cancellation, so there
 * is no backend state to clean up — we just surface a non-blocking toast and
 * bounce the user back to the billing settings page via `router.replace` so
 * the cancel route does not pollute browser history.
 */
export function UpgradeCancelPage() {
  // Defense in depth: this page is only reachable from a Stripe Checkout
  // session that started on the billing page (itself gated). But deep-link
  // or bookmark navigation can still land a self-hosted user here, where
  // the auto-redirect to `routes.settings.billing` would chain through
  // *that* page's `<Navigate />` back to general — together with a stray
  // "upgrade canceled" toast for an upgrade the user never started. Cleaner
  // to short-circuit at this page too.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Strict hosting predicate for the side effect below. `platformGate ===
  // "full"` is the *Render*-tier predicate — it's intentionally permissive
  // during the lifecycle-loading window so the page chrome stays mounted.
  // The toast + navigate side effect is a *Fetch/Interact*-tier action and
  // must wait for positive hosted resolution; otherwise a self-hosted
  // deep-link user sees the stray toast before `<Navigate />` flips below.
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  // Distinguish the genuine *resolving* window from terminal-non-hosted
  // states. The resolving window lets the existing "Returning you to
  // billing settings…" card render (effect short-circuits, but the auto-
  // redirect will fire once lifecycle resolves to hosted). Terminal-non-
  // hosted needs a manual escape hatch since the auto-redirect never
  // fires (Trap 6 cached-state variant applied to side-effect-tier).
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for positive hosted resolution before firing the toast +
    // redirect. During the lifecycle-loading window `platformGate ===
    // "full"` AND `isPlatformHosted === false` — running the effect here
    // would defeat the gate on a self-hosted deep-link. Once lifecycle
    // resolves, either `isPlatformHosted` flips true (run the effect) or
    // `platformGate` flips to `"gated"` (body's `<Navigate />` takes
    // over, this effect never runs).
    if (!isPlatformHosted) return;
    toast.info("Upgrade canceled. No changes to your plan.", {
      id: "pro-upgrade-cancel",
    });
    navigate(routes.settings.billing, { replace: true });
  }, [navigate, isPlatformHosted]);

  if (platformGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }
  if (platformGate === "disabled") {
    return (
      <div className="max-w-4xl space-y-6">
        <Notice tone="info">
          Log in to the Vellum platform to manage billing and usage.
        </Notice>
      </div>
    );
  }

  // Terminal non-hosted: the auto-redirect effect never runs because
  // `isPlatformHosted` stays false, and the body's "Returning…" message
  // would lie. Render a manual escape hatch instead. The lifecycle-
  // loading window still falls through to the body so the auto-redirect
  // fires once resolution lands.
  if (!isPlatformHosted && !isLifecycleLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <Notice tone="warning">
          Billing isn&apos;t available for the current assistant state.
        </Notice>
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={() =>
              navigate(routes.settings.billing, { replace: true })
            }
          >
            Return to billing
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Card padding="lg">
        <Typography as="h1" variant="title-large">
          Upgrade canceled
        </Typography>
        <Typography
          as="p"
          variant="body-medium-default"
          className="mt-2"
        >
          Returning you to billing settings…
        </Typography>
      </Card>
    </div>
  );
}
