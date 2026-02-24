import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { sendWhatsAppTextMessage } from "./api.js";

const log = getLogger("whatsapp-send");

// WhatsApp supports up to 4096 characters per text message
const WHATSAPP_MAX_MESSAGE_LEN = 4096;

function splitText(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_MESSAGE_LEN) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + WHATSAPP_MAX_MESSAGE_LEN, text.length);
    // Avoid splitting a surrogate pair
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitText(text);

  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(config, to, chunk);
  }

  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}
