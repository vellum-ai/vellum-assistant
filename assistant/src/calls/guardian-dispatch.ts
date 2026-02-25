/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Routes through the canonical notification pipeline (emitNotificationSignal)
 *
 * All per-channel delivery (vellum, telegram, sms) is handled by the
 * notification pipeline's adapters and broadcaster — no parallel delivery
 * logic lives here.
 */

import {
  createGuardianActionRequest,
} from '../memory/guardian-action-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
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

/**
 * Dispatch a guardian action request to all configured channels.
 * Delivery is handled entirely by the canonical notification pipeline.
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

    // Route through the canonical notification pipeline. The pipeline's
    // adapters handle all per-channel delivery (vellum, telegram, etc.)
    // and the broadcaster records delivery audit rows.
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
    });

    if (!signalResult.dispatched) {
      log.warn(
        { requestId: request.id, reason: signalResult.reason },
        'Notification pipeline did not dispatch guardian question',
      );
    }
  } catch (err) {
    log.error({ err, callSessionId }, 'Failed to dispatch guardian question');
  }
}
