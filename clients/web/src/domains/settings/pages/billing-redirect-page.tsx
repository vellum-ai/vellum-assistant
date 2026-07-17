import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * The Billing & Usage page moved to `/assistant/settings/usage`. Keep the old
 * `/assistant/settings/billing` route as a permanent redirect so existing
 * bookmarks — and the server-configured Stripe checkout/portal return URLs that
 * land here with `billing_status` / `session_id` / `adjust_plan` — continue to
 * work. All query params carry over verbatim. Billing is the destination
 * page's default tab when signed in, so these return flows reach the Billing
 * panel without an explicit `tab` (and a signed-out user, who can't reach these
 * flows anyway, falls back to Usage since the Billing tab is hidden for them).
 */
export function BillingRedirectPage() {
  const [searchParams] = useSearchParams();

  const query = searchParams.toString();

  return (
    <Navigate replace to={`${routes.settings.usage}${query ? `?${query}` : ""}`} />
  );
}
