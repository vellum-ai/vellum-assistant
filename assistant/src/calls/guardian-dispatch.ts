/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call controller detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Determines delivery destinations (telegram, sms, macos)
 * 3. Creates guardian_action_delivery rows for each destination
 * 4. Sends HTTP POST to gateway for external channels
 * 5. Emits IPC events for the mac channel
 */

import { getLogger } from '../util/logger.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import {
  createGuardianActionRequest,
  createGuardianActionDelivery,
  updateDeliveryStatus,
} from '../memory/guardian-action-store.js';
import { getUserConsultationTimeoutMs } from './call-constants.js';
import { getOrCreateConversation } from '../memory/conversation-key-store.js';
import { addMessage, updateConversationTitle } from '../memory/conversation-store.js';
import type { CallPendingQuestion } from './types.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';
import { generateGuardianCopy } from './guardian-question-copy.js';

const log = getLogger('guardian-dispatch');

export interface GuardianDispatchParams {
  callSessionId: string;
  conversationId: string;
  assistantId: string;
  pendingQuestion: CallPendingQuestion;
  /** Broadcast function to emit IPC events to connected clients. */
  broadcast?: (msg: ServerMessage) => void;
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
    broadcast,
  } = params;

  try {
    const expiresAt = Date.now() + getUserConsultationTimeoutMs();

    // Create the action request
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

    // Emit notification signal through the unified pipeline (fire-and-forget).
    // The existing guardian dispatch logic below handles the actual delivery
    // to specific channels (telegram, sms, vellum), so this signal is
    // supplementary — it lets the decision engine log and potentially route
    // to additional channels in the future.
    void emitNotificationSignal({
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

    // Determine delivery destinations
    const destinations: Array<{
      channel: string;
      chatId?: string;
      externalUserId?: string;
    }> = [];

    // Telegram guardian binding
    const telegramBinding = getActiveBinding(assistantId, 'telegram');
    if (telegramBinding) {
      destinations.push({
        channel: 'telegram',
        chatId: telegramBinding.guardianDeliveryChatId,
        externalUserId: telegramBinding.guardianExternalUserId,
      });
    }

    // SMS guardian binding
    const smsBinding = getActiveBinding(assistantId, 'sms');
    if (smsBinding) {
      destinations.push({
        channel: 'sms',
        chatId: smsBinding.guardianDeliveryChatId,
        externalUserId: smsBinding.guardianExternalUserId,
      });
    }

    // Vellum (internal) delivery — always created
    destinations.push({ channel: 'vellum' });

    // Start LLM copy generation concurrently — only awaited in the vellum branch
    // so external channels (Telegram, SMS) dispatch without LLM latency.
    const guardianCopyPromise = generateGuardianCopy(
      pendingQuestion.questionText,
      request.requestCode,
    );

    // Create delivery rows and dispatch
    for (const dest of destinations) {
      if (dest.channel === 'vellum') {
        // Create conversation and delivery row synchronously so they exist
        // before awaiting LLM copy — prevents a race where an external channel
        // reply resolves the request before the vellum delivery is created.
        const macConvKey = `asst:${assistantId}:guardian:request:${request.id}`;
        const { conversationId: macConversationId } = getOrCreateConversation(macConvKey);

        const delivery = createGuardianActionDelivery({
          requestId: request.id,
          destinationChannel: 'vellum',
          destinationConversationId: macConversationId,
        });

        // Now await LLM-generated copy for the message content and thread title
        const guardianCopy = await guardianCopyPromise;

        // Persist the generated thread title to the DB (replaces the
        // "Generating title..." placeholder set by getOrCreateConversation)
        updateConversationTitle(macConversationId, guardianCopy.threadTitle);

        // Add the guardian question as the initial message in the thread
        addMessage(
          macConversationId,
          'assistant',
          JSON.stringify([{ type: 'text', text: guardianCopy.initialMessage }]),
          { userMessageChannel: 'voice', assistantMessageChannel: 'vellum', userMessageInterface: 'voice', assistantMessageInterface: 'vellum' },
        );

        // Emit IPC event for the vellum client with the server-created conversation
        if (broadcast) {
          broadcast({
            type: 'guardian_request_thread_created',
            conversationId: macConversationId,
            requestId: request.id,
            callSessionId,
            title: guardianCopy.threadTitle,
            questionText: request.questionText,
          } as ServerMessage);
        }
        updateDeliveryStatus(delivery.id, 'sent');
        log.info({ deliveryId: delivery.id, channel: 'vellum', macConversationId }, 'Vellum guardian delivery emitted');
      } else {
        const delivery = createGuardianActionDelivery({
          requestId: request.id,
          destinationChannel: dest.channel,
          destinationChatId: dest.chatId,
          destinationExternalUserId: dest.externalUserId,
        });
        // External channel delivery is handled by the notification pipeline;
        // mark the legacy delivery row as sent so auditing stays consistent.
        updateDeliveryStatus(delivery.id, 'sent');
        log.info({ deliveryId: delivery.id, channel: dest.channel }, 'Skipping legacy external delivery — notification pipeline active');
      }
    }
  } catch (err) {
    log.error({ err, callSessionId }, 'Failed to dispatch guardian question');
  }
}

