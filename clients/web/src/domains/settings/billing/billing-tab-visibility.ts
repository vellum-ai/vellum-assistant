import type { PlatformGateState } from "@/hooks/use-platform-gate";

/**
 * Whether the URL carries "billing intent" — a signal that the viewer arrived
 * to do something billing-specific rather than just browsing:
 *
 *   - `?tab=billing` — a direct deeplink to the Billing sub-tab.
 *   - `?adjust_plan` — an upgrade / manage-plan CTA (resize card, disk-pressure
 *     banner, managed-content prompts, General page).
 *   - `?billing_status` / `?session_id` — a Stripe checkout/portal return.
 */
export function hasBillingIntent(searchParams: URLSearchParams): boolean {
  return (
    searchParams.get("tab") === "billing" ||
    searchParams.has("adjust_plan") ||
    searchParams.has("billing_status") ||
    searchParams.has("session_id")
  );
}

/**
 * Whether to render the Billing in-page tab on the Usage page.
 *
 *   - `"full"` (signed in): always shown.
 *   - `"disabled"` (platform reachable, no session): normally hidden — a
 *     signed-out viewer has no billing to manage — but kept reachable when the
 *     URL carries billing intent, so `BillingTab`'s `PlatformLoginNotice` can
 *     carry those params (e.g. a Stripe `?session_id`) through sign-in and the
 *     viewer can finish the upgrade / post-checkout flow.
 *   - `"gated"` (local mode with the platform API off): never shown — there is
 *     no platform to log in to.
 */
export function shouldShowBillingTab(
  gate: PlatformGateState,
  searchParams: URLSearchParams,
): boolean {
  if (gate === "full") {
    return true;
  }
  if (gate === "disabled") {
    return hasBillingIntent(searchParams);
  }
  return false;
}
