import type { TrustRule } from "../db/trust-rule-store.js";
import type { RiskAssessment } from "./risk-types.js";

/**
 * Apply a matched user trust rule to a classification.
 *
 * A rule changes three things: the risk, the reason for it, and how it was
 * determined. It does not change what the invocation *is*, so everything the
 * classifier derived from the invocation (the allowlist ladder, directory
 * scopes, command candidates, sandbox flags) survives untouched.
 *
 * Override by spread, never by building a fresh assessment: the assistant
 * builds no options of its own, so an option this drops is one the user
 * cannot save a rule from, which is exactly what a user who already wrote a
 * rule is trying to avoid.
 */
export function applyUserRuleOverride(
  assessment: RiskAssessment,
  rule: Pick<TrustRule, "risk" | "description">,
): RiskAssessment {
  return {
    ...assessment,
    riskLevel: rule.risk,
    reason: rule.description,
    matchType: "user_rule",
  };
}
