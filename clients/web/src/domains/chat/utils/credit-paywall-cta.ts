export type CreditPaywallCtaMode = "add-credits" | "upgrade";

/**
 * Upgrade CTA shows ONLY in the experiment upgrade arm AND for a free-plan
 * org; an unknown/unresolved plan / unhydrated flags count as paid. Everything
 * else gets Add Credits.
 */
export function resolveCreditPaywallCta(args: {
  isUpgradeArm: boolean;
  isFreePlan: boolean | undefined;
}): CreditPaywallCtaMode {
  return args.isUpgradeArm && args.isFreePlan === true
    ? "upgrade"
    : "add-credits";
}
