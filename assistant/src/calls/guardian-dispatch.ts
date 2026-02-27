/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Routes through the canonical notification pipeline (emitNotificationSignal)
 * 3. Records guardian_action_delivery rows from pipeline delivery results
 */

import { getActiveBinding } from '../memory/channel-guardian-store.js';
import {
  countPendingRequestsByCallSessionId,
  createGuardianActionDelivery,
  createGuardianActionRequest,
  getGuardianConversationIdForCallSession,
  updateDeliveryStatus,
} from '../memory/guardian-action-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import type { NotificationDeliveryResult } from '../notifications/types.js';
import { getLogger } from '../util/logger.js';
import { getUserConsultationTimeoutMs } from './call-constants.js';
import type { CallPendingQuestion } from './types.js';

const log = getLogger('guardian-dispatch');

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

function applyDeliveryStatus(deliveryId: string, result: NotificationDeliveryResult): void {
  if (result.status === 'sent') {
    updateDeliveryStatus(deliveryId, 'sent');
    return;
  }
  const errorMessage = result.errorMessage ?? `Notification delivery status: ${result.status}`;
  updateDeliveryStatus(deliveryId, 'failed', errorMessage);
}

/**
 * Dispatch a guardian action request to all configured channels.
 * Fire-and-forget: errors are logged but do not propagate.
 */
export async function dispatchGuardianQuestion(params: GuardianDispatchParams): Promise<void> {
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

async function dispatchGuardianQuestionInner(params: GuardianDispatchParams): Promise<void> {
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

    // Create the action request record
    const request = createGuardianActionRequest({
      assistantId,
      kind: 'ask_guardian',
      sourceChannel: 'voice',
      sourceConversationId: conversationId,
      callSessionId,
      pendingQuestionId: pendingQuestion.id,
      questionText: pendingQuestion.questionText,
      expiresAt,
      toolName,
      inputDigest,
    });

    log.info(
      { requestId: request.id, requestCode: request.requestCode, callSessionId },
      'Created guardian action request',
    );

    // Count how many guardian requests are already pending for this call.
    // This count is a candidate-affinity hint: the decision engine uses it
    // to prefer reusing an existing thread when multiple questions arise
    // in the same call session.
    const activeGuardianRequestCount = countPendingRequestsByCallSessionId(callSessionId);

    // Look up the vellum conversation used for the first guardian question
    // in this call session. When found, pass it as an affinity hint so the
    // notification pipeline deterministically routes to the same conversation
    // instead of letting the LLM choose a different thread.
    const existingGuardianConversationId = getGuardianConversationIdForCallSession(callSessionId);
    const conversationAffinityHint = existingGuardianConversationId
      ? { vellum: existingGuardianConversationId }
      : undefined;

    if (existingGuardianConversationId) {
      log.info(
        { callSessionId, existingGuardianConversationId },
        'Found existing guardian conversation for call session — enforcing thread affinity',
      );
    }

    // Route through the canonical notification pipeline. The paired vellum
    // conversation from this pipeline is the canonical guardian thread.
    let vellumDeliveryId: string | null = null;
    const signalResult = await emitNotificationSignal({
      sourceEventName: 'guardian.question',
      sourceChannel: 'voice',
      sourceSessionId: callSessionId,
      assistantId,
      attentionHints: {
        requiresAction: true,
        urgency: 'high',
        deadlineAt: expiresAt,
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestId: request.id,
        requestCode: request.requestCode,
        callSessionId,
        questionText: pendingQuestion.questionText,
        pendingQuestionId: pendingQuestion.id,
        activeGuardianRequestCount,
      },
      conversationAffinityHint,
      dedupeKey: `guardian:${request.id}`,
      onThreadCreated: (info) => {
        if (info.sourceEventName !== 'guardian.question' || vellumDeliveryId) return;
        const delivery = createGuardianActionDelivery({
          requestId: request.id,
          destinationChannel: 'vellum',
          destinationConversationId: info.conversationId,
        });
        vellumDeliveryId = delivery.id;
      },
    });

    const telegramBinding = getActiveBinding(assistantId, 'telegram');
    const smsBinding = getActiveBinding(assistantId, 'sms');

    for (const result of signalResult.deliveryResults) {
      if (result.channel === 'vellum') {
        if (!vellumDeliveryId) {
          const delivery = createGuardianActionDelivery({
            requestId: request.id,
            destinationChannel: 'vellum',
            destinationConversationId: result.conversationId,
          });
          vellumDeliveryId = delivery.id;
        }
        applyDeliveryStatus(vellumDeliveryId, result);
        continue;
      }

      if (result.channel !== 'telegram' && result.channel !== 'sms') {
        continue;
      }

      const binding = result.channel === 'telegram' ? telegramBinding : smsBinding;
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: result.channel,
        destinationChatId: result.destination.length > 0 ? result.destination : undefined,
        destinationExternalUserId: binding?.guardianExternalUserId,
      });
      applyDeliveryStatus(delivery.id, result);
    }

    if (!vellumDeliveryId) {
      const fallback = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: 'vellum',
      });
      updateDeliveryStatus(
        fallback.id,
        'failed',
        `No vellum delivery result from notification pipeline (${signalResult.reason})`,
      );
      log.warn(
        { requestId: request.id, reason: signalResult.reason },
        'Notification pipeline did not produce a vellum delivery result',
      );
    }
  } catch (err) {
    log.error({ err, callSessionId }, 'Failed to dispatch guardian question');
  }
}
