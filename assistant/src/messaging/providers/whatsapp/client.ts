/**
 * Low-level WhatsApp operations.
 *
 * Calls the Meta Cloud API directly via ./api.ts — no gateway proxy hop.
 */

import { sendWhatsAppTextMessage } from "./api.js";

/** Result returned by sendMessage. */
export interface WhatsAppSendResult {
  ok: boolean;
  /**
   * The id the Cloud API assigned to the message (`messages[0].id`). Meta
   * returns it on every accepted send, so this is absent only when the API
   * answered with an unexpected shape.
   */
  messageId?: string;
}

/**
 * Send a WhatsApp text message via the Meta Cloud API.
 */
export async function sendMessage(
  to: string,
  text: string,
): Promise<WhatsAppSendResult> {
  const result = await sendWhatsAppTextMessage(to, text);
  return { ok: true, messageId: result.messages?.[0]?.id };
}
