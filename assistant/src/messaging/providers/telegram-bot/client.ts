/**
 * Low-level Telegram operations.
 *
 * Outbound message delivery routes through the gateway's /deliver/telegram
 * endpoint, which handles bot token management and Telegram API retries.
 * Connection verification calls the Telegram Bot API directly with the
 * stored bot token.
 */

import type { TelegramGetMeResponse } from './types.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DELIVERY_TIMEOUT_MS = 30_000;

export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Verify a bot token by calling Telegram's getMe API directly.
 * Used for testConnection() — the only operation that bypasses the gateway.
 */
export async function getMe(botToken: string): Promise<TelegramGetMeResponse> {
  const resp = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`, {
    method: 'POST',
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new TelegramApiError(
      resp.status,
      `Telegram getMe failed with status ${resp.status}`,
    );
  }

  return resp.json() as Promise<TelegramGetMeResponse>;
}

/**
 * Send a text message to a Telegram chat via the gateway's deliver endpoint.
 */
export async function sendMessage(
  gatewayUrl: string,
  bearerToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  await deliverToGateway(gatewayUrl, bearerToken, { chatId, text });
}

/**
 * Send a message with attachments to a Telegram chat via the gateway.
 */
export async function sendMessageWithAttachments(
  gatewayUrl: string,
  bearerToken: string,
  chatId: string,
  text: string | undefined,
  attachmentIds: string[],
): Promise<void> {
  await deliverToGateway(gatewayUrl, bearerToken, {
    chatId,
    text,
    attachments: attachmentIds.map((id) => ({ id })),
  });
}

/** Payload accepted by the gateway's /deliver/telegram endpoint. */
interface DeliverPayload {
  chatId: string;
  text?: string;
  attachments?: Array<{ id: string }>;
}

async function deliverToGateway(
  gatewayUrl: string,
  bearerToken: string,
  payload: DeliverPayload,
): Promise<void> {
  const url = `${gatewayUrl}/deliver/telegram`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable>');
    throw new TelegramApiError(
      resp.status,
      `Gateway /deliver/telegram failed (${resp.status}): ${body}`,
    );
  }
}
