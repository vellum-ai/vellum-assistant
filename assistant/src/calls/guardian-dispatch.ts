/**
 * Guardian dispatch engine for cross-channel voice calls.
 *
 * When a call orchestrator detects ASK_GUARDIAN, this module:
 * 1. Creates a guardian_action_request
 * 2. Determines delivery destinations (telegram, sms, mac)
 * 3. Creates guardian_action_delivery rows for each destination
 * 4. Sends HTTP POST to gateway for external channels
 * 5. Emits IPC events for the mac channel
 */

import { getLogger } from '../util/logger.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import {
  createGuardianActionRequest,
  createGuardianActionDelivery,
  updateDeliveryStatus,
} from '../memory/guardian-action-store.js';
import { deliverChannelReply } from '../runtime/gateway-client.js';
import { getUserConsultationTimeoutMs } from './call-constants.js';
import type { CallPendingQuestion } from './types.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';

const log = getLogger('guardian-dispatch');

/** Resolve the gateway base URL for internal delivery callbacks. */
function getGatewayBaseUrl(): string {
  if (process.env.GATEWAY_INTERNAL_BASE_URL) {
    return process.env.GATEWAY_INTERNAL_BASE_URL.replace(/\/+$/, '');
  }
  const port = Number(process.env.GATEWAY_PORT) || 7830;
  return `http://127.0.0.1:${port}`;
}

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

    // Mac (internal) delivery — always created
    destinations.push({ channel: 'mac' });

    // Create delivery rows and dispatch
    for (const dest of destinations) {
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: dest.channel,
        destinationChatId: dest.chatId,
        destinationExternalUserId: dest.externalUserId,
      });

      if (dest.channel === 'mac') {
        // Emit IPC event for the mac client
        if (broadcast) {
          broadcast({
            type: 'guardian_request_thread_created',
            conversationId,
            requestId: request.id,
            callSessionId,
            title: `Guardian question: ${pendingQuestion.questionText.slice(0, 80)}`,
          } as ServerMessage);
        }
        updateDeliveryStatus(delivery.id, 'sent');
        log.info({ deliveryId: delivery.id, channel: 'mac' }, 'Mac guardian delivery emitted');
      } else {
        // External channel — POST to gateway
        void deliverToExternalChannel(delivery.id, dest.channel, dest.chatId!, request.questionText, request.requestCode, assistantId);
      }
    }
  } catch (err) {
    log.error({ err, callSessionId }, 'Failed to dispatch guardian question');
  }
}

async function deliverToExternalChannel(
  deliveryId: string,
  channel: string,
  chatId: string,
  questionText: string,
  requestCode: string,
  assistantId: string,
): Promise<void> {
  const gatewayBase = getGatewayBaseUrl();
  const deliverUrl = `${gatewayBase}/deliver/${channel}`;

  const messageText = [
    `Your assistant needs your input during a phone call.`,
    ``,
    `Question: ${questionText}`,
    ``,
    `Reply to this message with your answer. (ref: ${requestCode})`,
  ].join('\n');

  try {
    await deliverChannelReply(deliverUrl, {
      chatId,
      text: messageText,
      assistantId,
    });
    updateDeliveryStatus(deliveryId, 'sent');
    log.info({ deliveryId, channel, chatId }, 'External guardian delivery sent');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateDeliveryStatus(deliveryId, 'failed', errorMsg);
    log.error({ err, deliveryId, channel, chatId }, 'External guardian delivery failed');
  }
}
