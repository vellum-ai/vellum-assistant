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
  createGuardianActionDelivery,
  createGuardianActionRequest,
  updateDeliveryStatus,
} from '../memory/guardian-action-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import type { NotificationDeliveryResult } from '../notifications/types.js';
import { getLogger } from '../util/logger.js';
import { getUserConsultationTimeoutMs } from './call-constants.js';
import type { CallPendingQuestion } from './types.js';

const log = getLogger('guardian-dispatch');

export interface GuardianDispatchParams {
  callSessionId: string;
  conversationId: string;
  assistantId: string;
  pendingQuestion: CallPendingQuestion;
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
  const {
    callSessionId,
    conversationId,
    assistantId,
    pendingQuestion,
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
    });

    log.info(
      { requestId: request.id, requestCode: request.requestCode, callSessionId },
      'Created guardian action request',
    );

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
      },
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
