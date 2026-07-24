export type CreditPaywallCtaMode =
  "add-credits-free" | "add-credits-paid" | "upgrade";

/**
 * Upgrade CTA shows ONLY in the experiment upgrade arm AND for a free-plan
 * org. Everything else gets Add Credits, whose copy differs for free vs paid
 * orgs; an unknown/unresolved plan / unhydrated flags count as paid.
 */
export function resolveCreditPaywallCta(args: {
  isUpgradeArm: boolean;
  isFreePlan: boolean | undefined;
}): CreditPaywallCtaMode {
  if (args.isUpgradeArm && args.isFreePlan === true) {
    return "upgrade";
  }
  return args.isFreePlan === true ? "add-credits-free" : "add-credits-paid";
}
