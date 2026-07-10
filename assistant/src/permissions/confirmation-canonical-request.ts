/**
 * Promote a `confirmation_request` (tool approval) into a canonical guardian
 * request and bridge it to the guardian's channels.
 *
 * Called fire-and-forget by the paths that emit a `confirmation_request`:
 * the `PermissionPrompter` (interactive tool approvals) and the ACP route
 * approval gate. Keeping the promotion at the emitter — rather than inside the
 * generic event hub — lets the hub stay a pure pub/sub primitive with no
 * dependency on the conversation registry or guardian bridge.
 *
 * Channel guardian decisions (reactions, buttons, text) all route through the
 * canonical pipeline, so without this record none of them can resolve the
 * confirmation.
 *
 * The heavy dependencies (conversation registry, canonical guardian store,
 * guardian bridge) are loaded lazily so importing this module — and therefore
 * the emitters — stays cheap and free of import-time database access.
 */

import type { ServerMessage } from "../daemon/message-protocol.js";
import { IntegrityError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("confirmation-canonical-request");

function resolveCanonicalRequestSourceType(
  sourceChannel: string,
): "desktop" | "channel" | "voice" {
  if (sourceChannel === "phone") return "voice";
  if (sourceChannel === "vellum") return "desktop";
  return "channel";
}

/**
 * Create a canonical guardian request + bridge for a `confirmation_request`
 * message. Safe to call fire-and-forget; failures are logged, never thrown.
 */
export async function createCanonicalRequestForConfirmation(
  msg: ServerMessage & { type: "confirmation_request" },
  conversationId: string,
): Promise<void> {
  try {
    const [
      { findConversation },
      { createCanonicalGuardianRequest, generateCanonicalRequestCode },
      { redactSecrets },
      { summarizeToolInput },
      { DAEMON_INTERNAL_ASSISTANT_ID },
      { bridgeConfirmationRequestToGuardian },
    ] = await Promise.all([
      import("../daemon/conversation-registry.js"),
      import("../contacts/canonical-guardian-store.js"),
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
    const canonicalRequest = createCanonicalGuardianRequest({
      id: msg.requestId,
      kind: "tool_approval",
      sourceType: resolveCanonicalRequestSourceType(sourceChannel),
      sourceChannel,
      conversationId,
      requesterExternalUserId: trustContext?.requesterExternalUserId,
      requesterChatId: trustContext?.requesterChatId,
      guardianExternalUserId: trustContext?.guardianExternalUserId,
      guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
      toolName: msg.toolName,
      commandPreview:
        redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) ||
        undefined,
      riskLevel: msg.riskLevel,
      activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
      executionTarget: msg.executionTarget,
      status: "pending",
      requestCode: generateCanonicalRequestCode(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    if (trustContext && conversation) {
      await bridgeConfirmationRequestToGuardian({
        canonicalRequest,
        trustContext,
        conversationId,
        toolName: msg.toolName,
        assistantId: conversation.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      });
    }
  } catch (err) {
    if (err instanceof IntegrityError) {
      // The confirmation could not be promoted to a canonical guardian request
      // (e.g. its trust context resolved no guardianPrincipalId). Channel
      // guardian decisions — reactions, buttons, and text — all route through
      // the canonical pipeline, so without this record none of them can resolve
      // the confirmation. Surface it rather than swallowing: for a guardian's
      // own confirmation a bound principal should always be present.
      log.warn(
        { err, conversationId, requestId: msg.requestId },
        "Could not create canonical guardian request for confirmation; channel guardian decisions will not work for it",
      );
    } else {
      log.debug(
        { err, conversationId },
        "Failed to create canonical request from broadcast",
      );
    }
  }
}
