import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { splitText } from "../util/split-text.js";
import { sendWhatsAppTextMessage } from "./api.js";

const log = getLogger("whatsapp-send");

// WhatsApp supports up to 4096 characters per text message
const WHATSAPP_MAX_MESSAGE_LEN = 4096;

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);

  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(config, to, chunk);
  }

  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}
