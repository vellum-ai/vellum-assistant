/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Routes through the canonical notification pipeline (emitNotificationSignal)
 * 3. Records guardian_action_delivery rows from pipeline delivery results
 */

import { findGuardianForChannel } from "../contacts/contact-store.js";
import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
  updateCanonicalGuardianDelivery,
} from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
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

function applyDeliveryStatus(
  deliveryId: string,
  result: NotificationDeliveryResult,
): void {
  if (result.status === "sent") {
    updateCanonicalGuardianDelivery(deliveryId, { status: "sent" });
    return;
  }
  updateCanonicalGuardianDelivery(deliveryId, { status: "failed" });
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

    // Voice decisions are handled in guardian threads tied to the assistant-
    // level guardian identity. Resolve the principal from the contacts table.
    let guardianPrincipalId: string | undefined;

    const guardianResult = findGuardianForChannel("vellum");
    if (guardianResult?.contact.principalId) {
      guardianPrincipalId = guardianResult.contact.principalId;
    }

    // Self-heal: if contacts don't have a principalId, bootstrap via
    // ensureVellumGuardianBinding so the pending_question request can
    // be attributed.
    if (!guardianPrincipalId) {
      log.info(
        { callSessionId, assistantId },
        "No guardian principal from contacts — self-healing for voice dispatch",
      );
      try {
        guardianPrincipalId = ensureVellumGuardianBinding(assistantId);
      } catch (err) {
        log.warn(
          { err, callSessionId, assistantId },
          "ensureVellumGuardianBinding failed during voice dispatch self-heal",
        );
      }
    }

    if (!guardianPrincipalId) {
      log.error(
        { callSessionId, assistantId },
        "Voice guardian dispatch: no guardianPrincipalId after contacts + self-heal — cannot create pending_question",
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
      expiresAt: new Date(expiresAt).toISOString(),
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
    // engine prefers reusing an existing thread.
    const activeGuardianRequestCount = listCanonicalGuardianRequests({
      status: "pending",
      sourceType: "voice",
    }).filter((r) => r.callSessionId === callSessionId).length;

    // Look up the vellum conversation used for the first guardian question
    // delivery in this call session. When found, pass it as an affinity hint
    // so the notification pipeline deterministically routes to the same
    // conversation instead of letting the LLM choose a different thread.
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
        "Found existing guardian conversation for call session — enforcing thread affinity",
      );
    }

    // Route through the canonical notification pipeline. The paired vellum
    // conversation from this pipeline is the canonical guardian thread.
    let vellumDeliveryId: string | null = null;
    const requestCode =
      request.requestCode ?? request.id.slice(0, 6).toUpperCase();
    const signalResult = await emitNotificationSignal({
      sourceEventName: "guardian.question",
      sourceChannel: "phone",
      sourceSessionId: callSessionId,
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
      onThreadCreated: (info) => {
        if (info.sourceEventName !== "guardian.question" || vellumDeliveryId)
          return;
        const delivery = createCanonicalGuardianDelivery({
          requestId: request.id,
          destinationChannel: "vellum",
          destinationConversationId: info.conversationId,
        });
        vellumDeliveryId = delivery.id;
      },
    });

    for (const result of signalResult.deliveryResults) {
      if (result.channel === "vellum") {
        if (!vellumDeliveryId) {
          const delivery = createCanonicalGuardianDelivery({
            requestId: request.id,
            destinationChannel: "vellum",
            destinationConversationId: result.conversationId,
          });
          vellumDeliveryId = delivery.id;
        }
        applyDeliveryStatus(vellumDeliveryId, result);
        continue;
      }

      const delivery = createCanonicalGuardianDelivery({
        requestId: request.id,
        destinationChannel: result.channel,
        destinationChatId:
          result.destination.length > 0 ? result.destination : undefined,
      });
      applyDeliveryStatus(delivery.id, result);
    }

    if (!vellumDeliveryId) {
      const fallback = createCanonicalGuardianDelivery({
        requestId: request.id,
        destinationChannel: "vellum",
      });
      updateCanonicalGuardianDelivery(fallback.id, { status: "failed" });
      log.warn(
        { requestId: request.id, reason: signalResult.reason },
        "Notification pipeline did not produce a vellum delivery result",
      );
    }
  } catch (err) {
    log.error({ err, callSessionId }, "Failed to dispatch guardian question");
  }
}
