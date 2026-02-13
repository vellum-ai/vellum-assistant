import pino from "pino";
import type { GatewayConfig } from "../config.js";
import { callTelegramApi } from "./api.js";

const log = pino({ name: "gateway:telegram-send" });

const TELEGRAM_MAX_MESSAGE_LEN = 4000;

function splitText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LEN) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + TELEGRAM_MAX_MESSAGE_LEN, text.length);
    // Avoid splitting a surrogate pair
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
      end--;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
): Promise<void> {
  const chunks = splitText(text);

  for (const chunk of chunks) {
    await callTelegramApi(config, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
}

export async function sendTypingIndicator(config: GatewayConfig, chatId: string): Promise<void> {
  try {
    await callTelegramApi(config, "sendChatAction", { chat_id: chatId, action: "typing" });
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
  }
}

export { splitText };
