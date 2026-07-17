import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * The Billing & Usage page was renamed to lead with Usage (always available);
 * Billing is now a sub-tab shown only when signed in to the Vellum platform.
 * Keep the old `/assistant/settings/billing` route as a permanent redirect so
 * existing bookmarks — and the server-configured Stripe checkout/portal return
 * URLs that land here with `billing_status` / `session_id` / `adjust_plan` —
 * continue to work. All query params are carried over verbatim; when none
 * targets a tab we default to Billing, matching the old page's default tab so
 * those return flows still reach the Billing panel (a signed-out user falls
 * back to Usage automatically, since the Billing tab is hidden for them).
 */
export function BillingRedirectPage() {
  const [searchParams] = useSearchParams();

  const params = new URLSearchParams(searchParams);
  if (!params.has("tab")) {
    params.set("tab", "billing");
  }
  const query = params.toString();

  return (
    <Navigate replace to={`${routes.settings.usage}${query ? `?${query}` : ""}`} />
  );
}
