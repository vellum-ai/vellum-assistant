export type CreditPaywallCtaMode = "add-credits" | "upgrade";

/**
 * Upgrade CTA shows ONLY in the experiment upgrade arm AND for a free-plan
 * org. Control arm, paid plan, or unknown/unresolved plan / unhydrated flags
 * all fall back to Add Credits (today's default for everyone).
 */
export function resolveCreditPaywallCta(args: {
  isUpgradeArm: boolean;
  isFreePlan: boolean | undefined;
}): CreditPaywallCtaMode {
  return args.isUpgradeArm && args.isFreePlan === true ? "upgrade" : "add-credits";
}
