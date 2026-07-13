/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Routes through the canonical notification pipeline (emitNotificationSignal)
 * 3. Records guardian_action_delivery rows from pipeline delivery results
 */

import { v4 as uuid } from "uuid";

import {
  createGuardianRequest,
  listGuardianRequestDeliveriesOrEmpty,
  listGuardianRequestsOrEmpty,
} from "../channels/gateway-guardian-requests.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
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
    // applyGuardianDecision requires strict equality with
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

    // Create the guardian request as the primary record.
    const request = await createGuardianRequest({
      id: uuid(),
      kind: "pending_question",
      sourceChannel: "phone",
      sourceConversationId: conversationId,
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
      "Created guardian request for voice dispatch",
    );

    // Both affinity hints below read from one voice-request listing; a
    // degraded (empty) read only weakens the hints.
    const voiceRequests = await listGuardianRequestsOrEmpty({
      sourceType: "voice",
    });

    // Count how many guardian requests are already pending for
    // this call session. Used as a candidate-affinity hint so the decision
    // engine prefers reusing an existing conversation.
    const activeGuardianRequestCount = voiceRequests.filter(
      (r) => r.status === "pending" && r.callSessionId === callSessionId,
    ).length;

    // Look up the vellum conversation used for the first guardian question
    // delivery in this call session. When found, pass it as an affinity hint
    // so the notification pipeline deterministically routes to the same
    // conversation instead of letting the LLM choose a different conversation.
    // Find earlier guardian requests for this call session and check their
    // deliveries for a vellum destination conversation ID.
    let existingGuardianConversationId: string | null = null;
    const priorRequests = voiceRequests.filter(
      (r) => r.callSessionId === callSessionId && r.id !== request.id,
    );
    for (const priorReq of priorRequests) {
      const deliveries = await listGuardianRequestDeliveriesOrEmpty(
        priorReq.id,
      );
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
    // conversation from this pipeline is the guardian conversation.
    let vellumDeliveryIdPromise: Promise<string | undefined> | undefined;
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
      // Synchronous callback: the write is kicked off here and awaited before
      // the post-broadcast recording loop reuses its row id.
      onConversationCreated: (info) => {
        if (
          info.sourceEventName !== "guardian.question" ||
          vellumDeliveryIdPromise
        ) {
          return;
        }
        vellumDeliveryIdPromise = recordApprovalCardDelivery({
          requestId: request.id,
          channel: "vellum",
          conversationId: info.conversationId,
        }).then((delivery) => delivery?.id);
      },
    });

    const vellumDeliveryId = await recordGuardianRequestDeliveries({
      requestId: request.id,
      deliveryResults: signalResult.deliveryResults,
      vellumDeliveryId: await vellumDeliveryIdPromise,
    });

    if (!vellumDeliveryId) {
      await recordApprovalCardDelivery({
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
