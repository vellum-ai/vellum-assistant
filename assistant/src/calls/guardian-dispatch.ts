/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Routes through the canonical notification pipeline (emitNotificationSignal)
 * 3. Records guardian_action_delivery rows from pipeline delivery results
 */

import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
} from "../contacts/canonical-guardian-store.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/canonical-delivery-recorder.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { getLogger } from "../util/logger.js";
import { getUserConsultationTimeoutMs } from "./call-constants.js";
import type { CallPendingQuestion } from "./types.js";

const log = getLogger("guardian-dispatch");

// Per-callSessionId serialization lock. Ensures that concurrent dispatches for
// the same call session are serialized so the second dispatch always sees the
// delivery row (and thus the guardian conversation ID) persisted by the first.
const pendingDispatches = new Map<string, Promise<void>>();

export interface GuardianDispatchParams {
  callSessionId: string;
  conversationId: string;
  assistantId: string;
  pendingQuestion: CallPendingQuestion;
  /** Tool identity for tool-approval requests (absent for informational ASK_GUARDIAN). */
  toolName?: string;
  /** Canonical SHA-256 digest of tool input for tool-approval requests. */
  inputDigest?: string;
}

/**
 * Dispatch a guardian action request to all configured channels.
 * Fire-and-forget: errors are logged but do not propagate.
 */
export async function dispatchGuardianQuestion(
  params: GuardianDispatchParams,
): Promise<void> {
  const { callSessionId } = params;

  // Serialize concurrent dispatches for the same call session so the second
  // dispatch always sees the guardian conversation ID persisted by the first.
  const preceding = pendingDispatches.get(callSessionId);
  const current = (preceding ?? Promise.resolve()).then(() =>
    dispatchGuardianQuestionInner(params),
  );
  // Store a suppressed-error variant so the chain never rejects, and keep
  // a stable reference for the cleanup identity check below.
  const suppressed = current.catch(() => {});
  pendingDispatches.set(callSessionId, suppressed);

  try {
    await current;
  } finally {
    // Clean up the map entry only if it still points to our promise, to avoid
    // removing a later dispatch's entry.
    if (pendingDispatches.get(callSessionId) === suppressed) {
      pendingDispatches.delete(callSessionId);
    }
  }
}

async function dispatchGuardianQuestionInner(
  params: GuardianDispatchParams,
): Promise<void> {
  const {
    callSessionId,
    conversationId,
    assistantId,
    pendingQuestion,
    toolName,
    inputDigest,
  } = params;

  try {
    const expiresAt = Date.now() + getUserConsultationTimeoutMs();

    // Resolve the request principal from the gateway guardian delivery — the
    // same source the submitting actor (guardian-action-routes /
    // actor-trust-resolver) resolves, so they cannot diverge.
    // applyCanonicalGuardianDecision requires strict equality with
    // request.guardianPrincipalId; sharing this gateway source guarantees the
    // stamped principal == the submitting principal.
    const guardians = await getGuardianDelivery({ channelTypes: ["vellum"] });
    const guardianPrincipalId = guardians
      ? (guardianForChannel(guardians, "vellum")?.principalId ?? undefined)
      : undefined;

    if (!guardianPrincipalId) {
      log.error(
        { callSessionId, assistantId },
        "Voice guardian dispatch: no guardianPrincipalId — gateway may not have started yet; cannot create pending_question",
      );
      return;
    }

    // Create the canonical guardian request as the primary record.
    const request = createCanonicalGuardianRequest({
      kind: "pending_question",
      sourceType: "voice",
      sourceChannel: "phone",
      conversationId,
      callSessionId,
      pendingQuestionId: pendingQuestion.id,
      questionText: pendingQuestion.questionText,
      guardianPrincipalId,
      toolName,
      inputDigest,
      expiresAt,
    });

    log.info(
      {
        requestId: request.id,
        requestCode: request.requestCode,
        callSessionId,
      },
      "Created canonical guardian request for voice dispatch",
    );

    // Count how many canonical guardian requests are already pending for
    // this call session. Used as a candidate-affinity hint so the decision
    // engine prefers reusing an existing conversation.
    const activeGuardianRequestCount = listCanonicalGuardianRequests({
      status: "pending",
      sourceType: "voice",
    }).filter((r) => r.callSessionId === callSessionId).length;

    // Look up the vellum conversation used for the first guardian question
    // delivery in this call session. When found, pass it as an affinity hint
    // so the notification pipeline deterministically routes to the same
    // conversation instead of letting the LLM choose a different conversation.
    // Find earlier canonical requests for this call session and check their
    // deliveries for a vellum destination conversation ID.
    let existingGuardianConversationId: string | null = null;
    const priorRequests = listCanonicalGuardianRequests({
      sourceType: "voice",
    }).filter((r) => r.callSessionId === callSessionId && r.id !== request.id);
    for (const priorReq of priorRequests) {
      const deliveries = listCanonicalGuardianDeliveries(priorReq.id);
      const vellumDelivery = deliveries.find(
        (d) => d.destinationChannel === "vellum" && d.destinationConversationId,
      );
      if (vellumDelivery?.destinationConversationId) {
        existingGuardianConversationId =
          vellumDelivery.destinationConversationId;
        break;
      }
    }
    const conversationAffinityHint = existingGuardianConversationId
      ? { vellum: existingGuardianConversationId }
      : undefined;

    if (existingGuardianConversationId) {
      log.info(
        { callSessionId, existingGuardianConversationId },
        "Found existing guardian conversation for call session — enforcing conversation affinity",
      );
    }

    // Route through the canonical notification pipeline. The paired vellum
    // conversation from this pipeline is the canonical guardian conversation.
    let vellumDeliveryId: string | undefined;
    const requestCode =
      request.requestCode ?? request.id.slice(0, 6).toUpperCase();
    const signalResult = await emitNotificationSignal({
      sourceEventName: "guardian.question",
      sourceChannel: "phone",
      sourceContextId: callSessionId,
      requiresConversation: true,
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        deadlineAt: expiresAt,
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestId: request.id,
        requestKind: "pending_question",
        requestCode,
        callSessionId,
        toolName,
        questionText: pendingQuestion.questionText,
        activeGuardianRequestCount,
      },
      conversationAffinityHint,
      dedupeKey: `guardian:${request.id}`,
      onConversationCreated: (info) => {
        if (info.sourceEventName !== "guardian.question" || vellumDeliveryId)
          return;
        vellumDeliveryId = recordApprovalCardDelivery({
          requestId: request.id,
          channel: "vellum",
          conversationId: info.conversationId,
        })?.id;
      },
    });

    vellumDeliveryId = recordGuardianRequestDeliveries({
      requestId: request.id,
      deliveryResults: signalResult.deliveryResults,
      vellumDeliveryId,
    });

    if (!vellumDeliveryId) {
      recordApprovalCardDelivery({
        requestId: request.id,
        channel: "vellum",
        status: "failed",
      });
      log.warn(
        { requestId: request.id, reason: signalResult.reason },
        "Notification pipeline did not produce a vellum delivery result",
      );
    }
  } catch (err) {
    log.error({ err, callSessionId }, "Failed to dispatch guardian question");
  }
}
