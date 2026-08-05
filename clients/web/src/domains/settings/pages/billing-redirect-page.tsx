import { Navigate, useLocation, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * The Billing & Usage page moved to `/assistant/settings/usage`. Keep the old
 * `/assistant/settings/billing` route as a permanent redirect so existing
 * bookmarks — and the server-configured Stripe checkout/portal return URLs that
 * land here with `billing_status` / `session_id` / `adjust_plan` — continue to
 * work. All query params and the hash carry over verbatim (platform emails
 * deep-link to `#daily-credit-limit` through this route). Billing is the
 * destination page's default tab when signed in, so these return flows reach
 * the Billing panel without an explicit `tab` (and a signed-out user, who
 * can't reach these flows anyway, falls back to Usage since the Billing tab is
 * hidden for them).
 */
export function BillingRedirectPage() {
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();

  const query = searchParams.toString();

  return (
    <Navigate
      replace
      to={`${routes.settings.usage}${query ? `?${query}` : ""}${hash}`}
    />
  );
}
