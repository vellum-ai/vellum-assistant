/**
 * Promote a `confirmation_request` (tool approval) into a guardian
 * request and bridge it to the guardian's channels.
 *
 * Called fire-and-forget by the paths that emit a `confirmation_request`:
 * the `PermissionPrompter` (interactive tool approvals) and the ACP route
 * approval gate. Keeping the promotion at the emitter — rather than inside the
 * generic event hub — lets the hub stay a pure pub/sub primitive with no
 * dependency on the conversation registry or guardian bridge.
 *
 * Channel guardian decisions (reactions, buttons, text) all route through the
 * guardian-request pipeline, so without this record none of them can resolve the
 * confirmation.
 *
 * The heavy dependencies (conversation registry, gateway guardian-request
 * client, guardian bridge) are loaded lazily so importing this module — and
 * therefore the emitters — stays cheap and free of import-time side effects.
 */

import type { ServerMessage } from "../daemon/message-protocol.js";
import { IntegrityError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("confirmation-guardian-request");

/**
 * Create a guardian request + bridge for a `confirmation_request`
 * message. The request row lives gateway-side; the request code is generated
 * by the gateway create. Safe to call fire-and-forget; failures are logged,
 * never thrown.
 */
export async function createGuardianRequestForConfirmation(
  msg: ServerMessage & { type: "confirmation_request" },
  conversationId: string,
): Promise<void> {
  try {
    const [
      { findConversation },
      { createGuardianRequest, expireGuardianRequest },
      { redactSecrets },
      { summarizeToolInput },
      { DAEMON_INTERNAL_ASSISTANT_ID },
      { bridgeConfirmationRequestToGuardian },
    ] = await Promise.all([
      import("../daemon/conversation-registry.js"),
      import("../channels/gateway-guardian-requests.js"),
      import("../security/secret-scanner.js"),
      import("../tools/tool-input-summary.js"),
      import("../runtime/assistant-scope.js"),
      import("../runtime/confirmation-request-guardian-bridge.js"),
    ]);

    const conversation = findConversation(conversationId);
    const trustContext = conversation?.trustContext;
    const sourceChannel = trustContext?.sourceChannel ?? "vellum";
    const inputRecord = msg.input as Record<string, unknown>;
    const activityRaw =
      (typeof inputRecord.activity === "string"
        ? inputRecord.activity
        : undefined) ??
      (typeof inputRecord.reason === "string" ? inputRecord.reason : undefined);
    // Tool approvals are decisionable: without a bound principal nobody could
    // ever decide them (mirrors the gateway create's integrity guard).
    const guardianPrincipalId = trustContext?.guardianPrincipalId;
    if (!guardianPrincipalId) {
      throw new IntegrityError(
        "Cannot create tool_approval request without guardianPrincipalId",
      );
    }
    const guardianRequest = await createGuardianRequest({
      id: msg.requestId,
      kind: "tool_approval",
      sourceChannel,
      sourceConversationId: conversationId,
      requesterExternalUserId: trustContext?.requesterExternalUserId,
      requesterChatId: trustContext?.requesterChatId,
      guardianExternalUserId: trustContext?.guardianExternalUserId,
      guardianPrincipalId,
      toolName: msg.toolName,
      commandPreview:
        redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) ||
        undefined,
      riskLevel: msg.riskLevel,
      activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
      executionTarget: msg.executionTarget,
      status: "pending",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    // The prompt is actionable before this fire-and-forget create lands, so
    // an instant in-app decision can resolve the confirmation while the row
    // is still in flight — its status CAS misses (no row yet) and the create
    // would strand a pending row for an already-resolved tool call. Reconcile:
    // if the confirmation is no longer pending, expire the fresh row (the
    // interaction-bound terminal state) and skip the guardian card fan-out.
    if (conversation && !conversation.hasPendingConfirmation(msg.requestId)) {
      await expireGuardianRequest(guardianRequest.id);
      log.info(
        { conversationId, requestId: msg.requestId },
        "Confirmation resolved before its guardian request landed; expired the row",
      );
      return;
    }

    if (trustContext && conversation) {
      await bridgeConfirmationRequestToGuardian({
        guardianRequest,
        trustContext,
        conversationId,
        toolName: msg.toolName,
        assistantId: conversation.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      });
    }
  } catch (err) {
    if (err instanceof IntegrityError) {
      // The confirmation could not be promoted to a guardian request
      // (e.g. its trust context resolved no guardianPrincipalId). Channel
      // guardian decisions — reactions, buttons, and text — all route through
      // the guardian-request pipeline, so without this record none of them can resolve
      // the confirmation. Surface it rather than swallowing: for a guardian's
      // own confirmation a bound principal should always be present.
      log.warn(
        { err, conversationId, requestId: msg.requestId },
        "Could not create guardian request for confirmation; channel guardian decisions will not work for it",
      );
    } else {
      log.debug(
        { err, conversationId },
        "Failed to create guardian request from broadcast",
      );
    }
  }
}
