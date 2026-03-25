/**
 * Barrel re-export for channel route modules.
 *
 * The implementation is split across:
 * - channel-route-shared.ts    — types, constants, shared utilities
 * - channel-inbound-routes.ts  — inbound message handling, conversation deletion
 * - channel-delivery-routes.ts — delivery ack, dead letters, reply delivery
 * - channel-guardian-routes.ts — guardian approval interception, expiry sweep
 */

import type { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import type { RouteDefinition } from "../http-router.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from "../http-types.js";
import {
  handleChannelDeliveryAck as _handleChannelDeliveryAck,
  handleListDeadLetters as _handleListDeadLetters,
  handleReplayDeadLetters as _handleReplayDeadLetters,
} from "./channel-delivery-routes.js";
import {
  handleChannelInbound as _handleChannelInbound,
  handleDeleteConversation as _handleDeleteConversation,
} from "./channel-inbound-routes.js";

export {
  handleChannelDeliveryAck,
  handleListDeadLetters,
  handleReplayDeadLetters,
} from "./channel-delivery-routes.js";
export {
  startGuardianExpirySweep,
  stopGuardianExpirySweep,
  sweepExpiredGuardianApprovals,
} from "./channel-guardian-routes.js";
export {
  handleChannelInbound,
  handleDeleteConversation,
} from "./channel-inbound-routes.js";
export { _setTestPollMaxWait } from "./channel-route-shared.js";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function channelRouteDefinitions(deps: {
  assistantId: string;
  processMessage?: MessageProcessor;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  getHeartbeatService?: () => HeartbeatService | undefined;
}): RouteDefinition[] {
  return [
    {
      endpoint: "channels/conversation",
      method: "DELETE",
      handler: async ({ req }) =>
        _handleDeleteConversation(req, deps.assistantId),
    },
    {
      endpoint: "channels/inbound",
      method: "POST",
      handler: async ({ req }) =>
        _handleChannelInbound(
          req,
          deps.processMessage,
          deps.assistantId,
          deps.approvalCopyGenerator,
          deps.approvalConversationGenerator,
          deps.guardianActionCopyGenerator,
          deps.guardianFollowUpConversationGenerator,
          deps.getHeartbeatService?.(),
        ),
    },
    {
      endpoint: "channels/delivery-ack",
      method: "POST",
      handler: async ({ req }) => _handleChannelDeliveryAck(req),
    },
    {
      endpoint: "channels/dead-letters",
      method: "GET",
      handler: () => _handleListDeadLetters(),
    },
    {
      endpoint: "channels/replay",
      method: "POST",
      handler: async ({ req }) => _handleReplayDeadLetters(req),
    },
  ];
}
