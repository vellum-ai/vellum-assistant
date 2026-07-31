import type { RiskThreshold } from "./types.js";

/**
 * True when the resolved auto-approve threshold is at its maximum ("high",
 * a.k.a. Full access / "dangerously skip permissions"). At this posture the
 * user has opted into auto-approving even high-risk tools, so safeguards that
 * promote an allow → prompt for fresh human review are intentionally skipped.
 */
export function isFullAccessThreshold(threshold: RiskThreshold): boolean {
  return threshold === "high";
}
