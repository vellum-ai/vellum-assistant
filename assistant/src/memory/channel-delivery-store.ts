/**
 * Channel inbound idempotency + delivery state tracking.
 *
 * This module re-exports from focused sub-modules for backward compatibility.
 * New code should import directly from the relevant sub-module:
 *   - delivery-crud.ts    — inbound event CRUD and payload management
 *   - delivery-status.ts  — processing status tracking and dead-letter queue
 *   - delivery-channels.ts — verification replies, segment progress, delivery guards
 */

export type { PendingVerificationReply } from "./delivery-channels.js";
export {
  claimRunDelivery,
  clearPendingVerificationReply,
  getDeliveredSegmentCount,
  getPendingVerificationReply,
  resetAllRunDeliveryClaims,
  resetRunDeliveryClaim,
  storePendingVerificationReply,
  updateDeliveredSegmentCount,
} from "./delivery-channels.js";
export type { InboundResult, RecordInboundOptions } from "./delivery-crud.js";
export {
  clearPayload,
  deleteInbound,
  findMessageBySourceId,
  getLatestStoredPayload,
  linkMessage,
  recordInbound,
  storePayload,
} from "./delivery-crud.js";
export {
  acknowledgeDelivery,
  getDeadLetterEvents,
  getRetryableEvents,
  markProcessed,
  markRetryableFailure,
  recordProcessingFailure,
  replayDeadLetters,
} from "./delivery-status.js";
