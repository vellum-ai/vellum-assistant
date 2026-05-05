/**
 * Guardian/approval routes: approval interception, approval prompt delivery,
 * and guardian expiry sweep.
 *
 * Implementation is split across:
 * - guardian-approval-prompt.ts       — rich/plain-text approval prompt delivery
 * - guardian-approval-interception.ts — approval interception and decision routing
 * - guardian-expiry-sweep.ts          — periodic expiry sweep for stale approvals
 */
export {
  type ApprovalInterceptionParams,
  type ApprovalInterceptionResult,
} from "./guardian-approval-interception.js";
export { type DeliverGeneratedApprovalPromptParams } from "./guardian-approval-prompt.js";
export {
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
  sweepExpiredGuardianApprovals,
} from "./guardian-expiry-sweep.js";
