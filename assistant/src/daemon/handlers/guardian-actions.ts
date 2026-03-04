import { processGuardianDecision } from "../../runtime/guardian-action-service.js";
import { resolveLocalIpcTrustContext } from "../../runtime/local-actor-identity.js";
import { listGuardianDecisionPrompts } from "../../runtime/routes/guardian-action-routes.js";
import type {
  GuardianActionDecision,
  GuardianActionsPendingRequest,
} from "../ipc-protocol.js";
import { defineHandlers, log } from "./shared.js";

export const guardianActionsHandlers = defineHandlers({
  guardian_actions_pending_request: (
    msg: GuardianActionsPendingRequest,
    socket,
    ctx,
  ) => {
    const prompts = listGuardianDecisionPrompts({
      conversationId: msg.conversationId,
      channel: "vellum",
    });
    ctx.send(socket, {
      type: "guardian_actions_pending_response",
      conversationId: msg.conversationId,
      prompts,
    });
  },

  guardian_action_decision: async (
    msg: GuardianActionDecision,
    socket,
    ctx,
  ) => {
    try {
      const localTrustCtx = resolveLocalIpcTrustContext("vellum");

      const result = await processGuardianDecision({
        requestId: msg.requestId,
        action: msg.action,
        conversationId: msg.conversationId,
        channel: "vellum",
        actorContext: {
          externalUserId: localTrustCtx.guardianExternalUserId,
          guardianPrincipalId: localTrustCtx.guardianPrincipalId ?? undefined,
        },
      });

      if (!result.ok) {
        ctx.send(socket, {
          type: "guardian_action_decision_response",
          applied: false,
          reason: result.error,
          requestId: msg.requestId,
        });
        return;
      }

      ctx.send(socket, {
        type: "guardian_action_decision_response",
        applied: result.applied,
        ...(result.applied
          ? { requestId: result.requestId }
          : {
              reason: result.reason,
              ...(result.resolverFailureReason
                ? { resolverFailureReason: result.resolverFailureReason }
                : {}),
              requestId: result.requestId ?? msg.requestId,
            }),
      });
    } catch (err) {
      log.error(
        { err, requestId: msg.requestId },
        "guardian_action_decision: unhandled error",
      );
      ctx.send(socket, {
        type: "guardian_action_decision_response",
        applied: false,
        reason: "internal_error",
        requestId: msg.requestId,
      });
    }
  },
});
