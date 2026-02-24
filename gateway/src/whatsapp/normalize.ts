import type { GatewayInboundEventV1 } from "../types.js";

// WhatsApp Cloud API webhook payload shapes
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples

interface WhatsAppContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface WhatsAppTextMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "text";
  text: { body: string };
}

interface WhatsAppAudioMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "audio" | "video" | "image" | "document" | "sticker";
}

type WhatsAppMessage = WhatsAppTextMessage | WhatsAppAudioMessage;

interface WhatsAppValue {
  messaging_product: "whatsapp";
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  // statuses are delivery/read receipts — we ignore them
  statuses?: unknown[];
}

interface WhatsAppChange {
  field: string;
  value?: WhatsAppValue;
}

interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

export interface NormalizedWhatsAppMessage {
  event: Omit<GatewayInboundEventV1, "routing">;
  /** Original WhatsApp message ID — used for marking as read. */
  whatsappMessageId: string;
}

/**
 * Normalize a WhatsApp Cloud API webhook payload into a GatewayInboundEventV1.
 *
 * Returns null if:
 * - The payload is not a WhatsApp messages webhook
 * - The message type is not text (audio/video/image/document are unsupported)
 * - Required fields are missing
 *
 * Only processes the first text message from the first entry/change to keep the
 * handler simple. Meta recommends acknowledging all webhooks regardless.
 */
export function normalizeWhatsAppWebhook(
  payload: Record<string, unknown>,
): NormalizedWhatsAppMessage | null {
  const wh = payload as WhatsAppWebhookPayload;

  if (wh.object !== "whatsapp_business_account") return null;

  const entry = wh.entry?.[0];
  if (!entry) return null;

  const change = entry.changes?.find((c) => c.field === "messages");
  if (!change?.value) return null;

  const value = change.value;
  const messages = value.messages;
  if (!messages || messages.length === 0) return null;

  const msg = messages[0];

  // Only forward text messages; other types (image, audio, etc.) are not supported
  if (msg.type !== "text") return null;

  const textMsg = msg as WhatsAppTextMessage;
  const body = textMsg.text?.body?.trim() ?? "";

  // from is the sender's WhatsApp phone number in E.164 format
  const from = textMsg.from;
  if (!from) return null;

  // Resolve display name from contacts array when available
  const contact = value.contacts?.find((c) => c.wa_id === from);
  const displayName = contact?.profile?.name ?? from;

  return {
    whatsappMessageId: textMsg.id,
    event: {
      version: "v1",
      sourceChannel: "whatsapp",
      receivedAt: new Date(Number(textMsg.timestamp) * 1000).toISOString(),
      message: {
        content: body,
        // Use sender phone number as the chat identifier for 1:1 conversations
        externalChatId: from,
        externalMessageId: textMsg.id,
      },
      sender: {
        externalUserId: from,
        displayName,
      },
      source: {
        updateId: textMsg.id,
        messageId: textMsg.id,
        chatType: "private",
      },
      raw: payload,
    },
  };
}
