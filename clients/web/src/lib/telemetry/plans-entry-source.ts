import { PLANS_SOURCE_PARAM, routes } from "@/utils/routes";

/**
 * Entry-source tags for the plans takeover — the producer half of the
 * "how did the user get to `/assistant/plans`?" attribution described in
 * `plans-entry-telemetry.ts`. Kept separate from the emitter so navigation
 * call sites don't pull in the ingest transport chain (generated sdk, client
 * identity, consent store); they only build a tagged URL.
 *
 * The marketing pricing page lives in `vellum-assistant-platform`
 * (`web/src/components/marketing/PricingPage/pricing-body.tsx`) and cannot
 * import this module — it produces `source=marketing_pricing` as a raw
 * string. Keep that spelling in the union below.
 */

/** Where a `/assistant/plans` visit came from. */
export type PlansEntrySource =
  /** Marketing `/pricing` CTAs (produced cross-app as a raw string). */
  | "marketing_pricing"
  /** Disk-pressure banner "Upgrade Storage" in its low-storage warning band. */
  | "disk_pressure_warning"
  /** Disk-pressure banner "Upgrade Storage" in its cleanup band. */
  | "disk_pressure_cleanup"
  /** Disk-pressure critical (acknowledgement-required) modal. */
  | "disk_pressure_critical"
  /** Out-of-credits upsell card "View plans" (upgrade experiment arm). */
  | "out_of_credits"
  /** Resize card's "Upgrade your plan" modal CTA. */
  | "resize_upgrade_modal"
  /** "Upgrade plan" link in the resize modal's footer. */
  | "resize_modal_link"
  /** Billing settings plan card's "View All Plans". */
  | "billing_plan_card"
  /** Managed-email entitlement wall "Upgrade". */
  | "email_upsell"
  /** No source tag on the URL — typed URL, refresh, internal redirects. */
  | "direct";

/** Plans-takeover URL tagged with the entry source that produced the visit. */
export function plansRouteForSource(source: PlansEntrySource): string {
  return `${routes.plans}?${PLANS_SOURCE_PARAM}=${encodeURIComponent(source)}`;
}

/**
 * Entry source for a disk-pressure banner mode. Takes the mode as a literal
 * union (structurally `DiskPressureBannerMode`) so `lib/` doesn't import from
 * `components/`. The acknowledgement-required modal reports as `critical` —
 * that's the state it renders.
 */
export function diskPressurePlansSource(
  mode: "warning" | "cleanup" | "acknowledgement-required",
): PlansEntrySource {
  switch (mode) {
    case "warning":
      return "disk_pressure_warning";
    case "cleanup":
      return "disk_pressure_cleanup";
    case "acknowledgement-required":
      return "disk_pressure_critical";
  }
}
