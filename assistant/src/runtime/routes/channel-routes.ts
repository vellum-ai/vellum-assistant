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
  GATEWAY_ORIGIN_HEADER,
  verifyGatewayOrigin,
  type ActorRole,
  type DenialReason,
  type GuardianContext,
  _setTestPollMaxWait,
} from './channel-route-shared.js';

export {
  handleDeleteConversation,
  handleChannelInbound,
} from './channel-inbound-routes.js';

export {
  handleListDeadLetters,
  handleReplayDeadLetters,
  handleChannelDeliveryAck,
} from './channel-delivery-routes.js';

export {
  sweepExpiredGuardianApprovals,
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
} from './channel-guardian-routes.js';
