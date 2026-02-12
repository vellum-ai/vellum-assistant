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
    chunks.push(text.slice(cursor, cursor + TELEGRAM_MAX_MESSAGE_LEN));
    cursor += TELEGRAM_MAX_MESSAGE_LEN;
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

export { splitText };
