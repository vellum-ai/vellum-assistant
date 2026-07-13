/**
 * Tool grant request creation and guardian notification helper.
 *
 * Encapsulates the "create/dedupe canonical tool_grant_request + emit notification"
 * logic so non-guardian channel actors can escalate tool invocations that require
 * guardian approval. Modeled after the access-request-helper pattern.
 *
 * Invariants preserved:
 * - Unverified actors are fail-closed (caller must gate before calling).
 * - Guardians cannot self-approve (grant minting uses guardian identity).
 * - Notification routing goes through emitNotificationSignal().
 */

import {
  createGuardianRequest,
  listGuardianRequestsOrEmpty,
} from "../channels/gateway-guardian-requests.js";
import type { ChannelId } from "../channels/types.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
import { getLogger } from "../util/logger.js";
import { getGuardianBinding } from "./channel-verification-service.js";
import { resolveDecidableGuardianPrincipalId } from "./local-actor-identity.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("tool-grant-request-helper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolGrantRequestParams {
  assistantId: string;
  sourceChannel: ChannelId;
  conversationId: string;
  requesterExternalUserId: string;
  requesterChatId?: string;
  requesterIdentifier?: string;
  toolName: string;
  inputDigest: string;
  questionText: string;
}

export type ToolGrantRequestResult =
  | { created: true; requestId: string; requestCode: string | null }
  | { deduped: true; requestId: string; requestCode: string | null }
  | { failed: true; reason: "no_guardian_binding" | "missing_identity" };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Create/dedupe a canonical tool_grant_request and emit a notification signal
 * so the guardian can approve or deny the tool invocation.
 *
 * Returns a result indicating whether a new request was created, an existing
 * one was deduped, or the escalation failed (no binding, missing identity).
 */
export async function createOrReuseToolGrantRequest(
  params: ToolGrantRequestParams,
): Promise<ToolGrantRequestResult> {
  const {
    assistantId,
    sourceChannel,
    conversationId,
    requesterExternalUserId,
    requesterChatId,
    requesterIdentifier,
    toolName,
    inputDigest,
    questionText,
  } = params;

  if (!requesterExternalUserId) {
    return { failed: true, reason: "missing_identity" };
  }

  const binding = await getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, assistantId },
      "No guardian binding for tool grant request escalation",
    );
    return { failed: true, reason: "no_guardian_binding" };
  }

  // A binding with no principal is unresolved, not empty: adopt the vellum
  // anchor principal so the resulting request is decidable by the guardian.
  // When neither resolves, fail closed — a principal-less tool_grant_request
  // can never be authorized by anyone.
  const guardianPrincipalId = await resolveDecidableGuardianPrincipalId(
    binding.guardianPrincipalId,
  );
  if (!guardianPrincipalId) {
    log.warn(
      { sourceChannel, assistantId },
      "Guardian principal unresolved for tool grant request escalation",
    );
    return { failed: true, reason: "no_guardian_binding" };
  }

  // Deduplicate: skip creation if there is already a pending guardian request
  // for the same requester + conversation + tool + input digest + guardian.
  // Guardian identity is included so that after a guardian rebind, old requests
  // tied to the previous guardian don't block creation of a new approvable
  // request. A degraded (empty) read falls through to creation, whose
  // fail-closed throw prevents a prompt without a persisted request.
  const existing = await listGuardianRequestsOrEmpty({
    status: "pending",
    requesterExternalUserId,
    sourceConversationId: conversationId,
    kind: "tool_grant_request",
    toolName,
  });
  const dedupeMatch = existing.find(
    (r) =>
      r.inputDigest === inputDigest &&
      r.guardianExternalUserId === binding.guardianExternalUserId,
  );
  if (dedupeMatch) {
    log.debug(
      {
        sourceChannel,
        requesterExternalUserId,
        toolName,
        existingId: dedupeMatch.id,
      },
      "Skipping duplicate tool grant request notification",
    );
    return {
      deduped: true,
      requestId: dedupeMatch.id,
      requestCode: dedupeMatch.requestCode,
    };
  }

  const senderLabel = requesterIdentifier || requesterExternalUserId;
  const requestId = `tool-grant-${assistantId}-${sourceChannel}-${requesterExternalUserId}-${Date.now()}`;

  const guardianRequest = await createGuardianRequest({
    id: requestId,
    kind: "tool_grant_request",
    sourceChannel,
    sourceConversationId: conversationId,
    requesterExternalUserId,
    requesterChatId: requesterChatId ?? undefined,
    guardianExternalUserId: binding.guardianExternalUserId,
    guardianPrincipalId,
    toolName,
    inputDigest,
    questionText,
    expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
  });
  const requestCode =
    guardianRequest.requestCode ?? guardianRequest.id.slice(0, 6).toUpperCase();

  // The vellum delivery row is created up front in onConversationCreated so the
  // in-app client sees it immediately; the post-resolve recorder reuses it.
  let vellumDeliveryIdPromise: Promise<string | undefined> | undefined;

  // Emit notification so guardian is alerted. Uses 'guardian.question' as
  // sourceEventName so that existing request-code guidance in the notification
  // pipeline is preserved.
  const signalPromise = emitNotificationSignal({
    sourceEventName: "guardian.question",
    sourceChannel,
    sourceContextId: conversationId,
    requiresConversation: true,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId: guardianRequest.id,
      requestKind: "tool_grant_request",
      requestCode,
      sourceChannel,
      requesterExternalUserId,
      requesterChatId: requesterChatId ?? null,
      requesterIdentifier: senderLabel,
      toolName,
      questionText,
    },
    dedupeKey: `tool-grant-request:${guardianRequest.id}`,
    // The broadcaster awaits the returned promise, so the delivery row is
    // durable before the client can act on the conversation.
    onConversationCreated: (info) => {
      vellumDeliveryIdPromise ??= recordApprovalCardDelivery({
        requestId: guardianRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      }).then((delivery) => delivery?.id);
      return vellumDeliveryIdPromise.then(() => undefined);
    },
  });

  // Record deliveries from the notification pipeline results (fire-and-forget;
  // the recorder is best-effort and never rejects).
  void signalPromise.then(async (signalResult) => {
    await recordGuardianRequestDeliveries({
      requestId: guardianRequest.id,
      deliveryResults: signalResult.deliveryResults,
      vellumDeliveryId: await vellumDeliveryIdPromise,
    });
  });

  log.info(
    {
      sourceChannel,
      requesterExternalUserId,
      toolName,
      requestId: guardianRequest.id,
      requestCode: guardianRequest.requestCode,
    },
    "Guardian notified of tool grant request",
  );

  return {
    created: true,
    requestId: guardianRequest.id,
    requestCode: guardianRequest.requestCode,
  };
}
