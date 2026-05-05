/**
 * Types extracted from guardian-approval-interception.ts to break the
 * interception ↔ guardian-text-engine-strategy cycle.
 */

export interface ApprovalInterceptionResult {
  handled: boolean;
  type?:
    | "decision_applied"
    | "assistant_turn"
    | "guardian_decision_applied"
    | "stale_ignored";
}
