import { getLogger } from '../util/logger.js';
import type { RuntimeAttachmentMetadata } from './http-types.js';
import type { ApprovalUIMetadata } from './channel-approval-types.js';

const log = getLogger('gateway-client');

const DELIVERY_TIMEOUT_MS = 30_000;

export interface ChannelReplyPayload {
  chatId: string;
  text?: string;
  assistantId?: string;
  attachments?: RuntimeAttachmentMetadata[];
  approval?: ApprovalUIMetadata;
}

export async function deliverChannelReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
  bearerToken?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }

  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    log.error(
      { status: response.status, body, callbackUrl, chatId: payload.chatId },
      'Channel reply delivery failed',
    );
    throw new Error(`Channel reply delivery failed (${response.status}): ${body}`);
  }

  log.info({ chatId: payload.chatId, callbackUrl }, 'Channel reply delivered');
}

/**
 * Deliver an approval prompt (text + inline keyboard metadata) to the
 * gateway so it can render the approval UI in the channel.
 */
export async function deliverApprovalPrompt(
  callbackUrl: string,
  chatId: string,
  text: string,
  approval: ApprovalUIMetadata,
  assistantId?: string,
  bearerToken?: string,
): Promise<void> {
  await deliverChannelReply(callbackUrl, { chatId, text, approval, assistantId }, bearerToken);
}
