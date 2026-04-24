/**
 * Low-level Telegram operations.
 *
 * Calls the Telegram Bot API directly via ./api.ts — no gateway proxy hop.
 * Connection verification calls the Telegram Bot API directly with the
 * stored bot token.
 */

import { callTelegramBotApi } from "./api.js";
import type { TelegramGetMeResponse } from "./types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DELIVERY_TIMEOUT_MS = 30_000;

export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

/**
 * Verify a bot token by calling Telegram's getMe API directly.
 * Used for testConnection() — takes a raw bot token (not from the store)
 * because callers may be testing an arbitrary token.
 */
export async function getMe(botToken: string): Promise<TelegramGetMeResponse> {
  const resp = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`, {
    method: "POST",
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

/** Result returned by sendMessage. */
export interface TelegramSendResult {
  ok: boolean;
}

/**
 * Send a Telegram text message via the Bot API directly.
 */
export async function sendMessage(
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
  await callTelegramBotApi("sendMessage", { chat_id: chatId, text });
  return { ok: true };
}
