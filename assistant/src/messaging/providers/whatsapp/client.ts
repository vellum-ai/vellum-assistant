/**
 * Low-level WhatsApp operations.
 *
 * Calls the Meta Cloud API directly via ./api.ts — no gateway proxy hop.
 */

import { sendWhatsAppTextMessage } from "./api.js";

/** Result returned by sendMessage. */
export interface WhatsAppSendResult {
  ok: boolean;
}

/**
 * Send a WhatsApp text message via the Meta Cloud API.
 */
export async function sendMessage(
  to: string,
  text: string,
): Promise<WhatsAppSendResult> {
  await sendWhatsAppTextMessage(to, text);
  return { ok: true };
}
