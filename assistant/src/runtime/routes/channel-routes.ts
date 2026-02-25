/**
 * Barrel re-export for channel route modules.
 *
 * The implementation is split across:
 * - channel-route-shared.ts    — types, constants, shared utilities
 * - channel-inbound-routes.ts  — inbound message handling, conversation deletion
 * - channel-delivery-routes.ts — delivery ack, dead letters, reply delivery
 * - channel-guardian-routes.ts — guardian approval interception, expiry sweep
 */
export {
  handleChannelDeliveryAck,
  handleListDeadLetters,
  handleReplayDeadLetters,
} from './channel-delivery-routes.js';
export {
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
  sweepExpiredGuardianApprovals,
} from './channel-guardian-routes.js';
export {
  handleChannelInbound,
  handleDeleteConversation,
} from './channel-inbound-routes.js';
export {
  _setTestPollMaxWait,
  type ActorRole,
  type DenialReason,
  GATEWAY_ORIGIN_HEADER,
  type GuardianContext,
  verifyGatewayOrigin,
} from './channel-route-shared.js';
