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

interface WhatsAppInteractiveMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "interactive";
  interactive: {
    type: "button_reply";
    button_reply: {
      id: string;
      title: string;
    };
  };
}

interface WhatsAppAudioMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "audio" | "video" | "image" | "document" | "sticker";
}

type WhatsAppMessage = WhatsAppTextMessage | WhatsAppInteractiveMessage | WhatsAppAudioMessage;

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
 * Normalize a WhatsApp Cloud API webhook payload into an array of GatewayInboundEventV1 events.
 *
 * Returns an empty array if:
 * - The payload is not a WhatsApp messages webhook
 * - Required fields are missing
 *
 * Non-text messages (audio/video/image/document) within the batch are skipped.
 * Meta may batch multiple messages in a single webhook payload; we process all
 * of them rather than discarding messages beyond the first.
 */
export function normalizeWhatsAppWebhook(
  payload: Record<string, unknown>,
): NormalizedWhatsAppMessage[] {
  const wh = payload as WhatsAppWebhookPayload;

  if (wh.object !== "whatsapp_business_account") return [];

  const results: NormalizedWhatsAppMessage[] = [];

  for (const entry of wh.entry ?? []) {
    const change = entry.changes?.find((c) => c.field === "messages");
    if (!change?.value) continue;

    const value = change.value;
    const messages = value.messages;
    if (!messages || messages.length === 0) continue;

    for (const msg of messages) {
      let body: string;
      let callbackData: string | undefined;

      if (msg.type === "text") {
        const textMsg = msg as WhatsAppTextMessage;
        body = textMsg.text?.body?.trim() ?? "";
      } else if (msg.type === "interactive") {
        // Interactive button reply — extract the button ID as callback data
        const interactiveMsg = msg as WhatsAppInteractiveMessage;
        if (interactiveMsg.interactive?.type !== "button_reply") continue;
        const buttonReply = interactiveMsg.interactive.button_reply;
        if (!buttonReply?.id) continue;
        callbackData = buttonReply.id;
        body = buttonReply.title ?? "";
      } else {
        // Other types (image, audio, etc.) are not supported
        continue;
      }

      // from is the sender's WhatsApp phone number in E.164 format
      const from = msg.from;
      if (!from) continue;

      // Resolve display name from contacts array when available
      const contact = value.contacts?.find((c) => c.wa_id === from);
      const displayName = contact?.profile?.name ?? from;

      results.push({
        whatsappMessageId: msg.id,
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
          message: {
            content: body,
            // Use sender phone number as the chat identifier for 1:1 conversations
            externalChatId: from,
            externalMessageId: msg.id,
            ...(callbackData ? { callbackData } : {}),
          },
          sender: {
            externalUserId: from,
            displayName,
          },
          source: {
            updateId: msg.id,
            messageId: msg.id,
            chatType: "private",
          },
          raw: payload,
        },
      });
    }
  }

  return results;
}
