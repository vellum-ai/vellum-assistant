import { useEffect } from "react";

import { useNavigate } from "react-router";

import { Card } from "@vellum/design-library/components/card";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import { routes } from "@/utils/routes";

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
  const navigate = useNavigate();

  useEffect(() => {
    toast.info("Upgrade canceled. No changes to your plan.", {
      id: "pro-upgrade-cancel",
    });
    navigate(routes.settings.billing, { replace: true });
  }, [navigate]);

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
