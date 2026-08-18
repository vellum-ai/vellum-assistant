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
 * Overriding by spread rather than by rebuilding the assessment is the point.
 * Every classifier used to return a fresh object on this path and silently
 * dropped whatever it did not restate: the ladder went missing for skill and
 * schedule tools, directory scopes for file tools. Since the assistant builds
 * no options of its own, a dropped ladder means a prompt the user cannot save
 * a rule from, which is exactly the situation a user who already wrote a rule
 * is trying to get out of.
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
