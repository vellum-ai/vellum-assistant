/**
 * Channel inbound idempotency + delivery state tracking.
 *
 * This module re-exports from focused sub-modules for backward compatibility.
 * New code should import directly from the relevant sub-module:
 *   - delivery-crud.ts    — inbound event CRUD and payload management
 *   - delivery-status.ts  — processing status tracking and dead-letter queue
 *   - delivery-channels.ts — verification replies, segment progress, delivery guards
 */

export {
  recordInbound,
  linkMessage,
  findMessageBySourceId,
  storePayload,
  clearPayload,
  getLatestStoredPayload,
} from './delivery-crud.js';
export type { InboundResult, RecordInboundOptions } from './delivery-crud.js';

export {
  acknowledgeDelivery,
  markProcessed,
  recordProcessingFailure,
  getRetryableEvents,
  getDeadLetterEvents,
  replayDeadLetters,
} from './delivery-status.js';

export {
  storePendingVerificationReply,
  getPendingVerificationReply,
  clearPendingVerificationReply,
  getDeliveredSegmentCount,
  updateDeliveredSegmentCount,
  claimRunDelivery,
  resetRunDeliveryClaim,
  resetAllRunDeliveryClaims,
} from './delivery-channels.js';
export type { PendingVerificationReply } from './delivery-channels.js';
