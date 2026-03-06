import type { GatewayInboundEvent } from "../types.js";

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

interface WhatsAppMediaPayload {
  caption?: string;
  mime_type?: string;
  id?: string;
  file_size?: number;
  filename?: string;
}

interface WhatsAppMediaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: "audio" | "video" | "image" | "document" | "sticker";
  // image, video, and document messages can carry a caption
  image?: WhatsAppMediaPayload;
  video?: WhatsAppMediaPayload;
  document?: WhatsAppMediaPayload;
  audio?: WhatsAppMediaPayload;
  sticker?: WhatsAppMediaPayload;
}

type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppInteractiveMessage
  | WhatsAppMediaMessage;

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
  event: GatewayInboundEvent;
  /** Original WhatsApp message ID — used for marking as read. */
  whatsappMessageId: string;
  /** The media type when the message contained an attachment (image, video, etc.). */
  mediaType?: string;
}

/**
 * Normalize a WhatsApp Cloud API webhook payload into an array of GatewayInboundEvent events.
 *
 * Returns an empty array if:
 * - The payload is not a WhatsApp messages webhook
 * - Required fields are missing
 *
 * Media messages (image/video/audio/document/sticker) are normalized with any
 * accompanying caption as the message content. The `mediaType` field is set so
 * the caller can log that media content itself was not processed.
 *
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
      let mediaType: string | undefined;
      let attachments:
        | Array<{
            type: "image" | "video" | "audio" | "document" | "sticker";
            fileId: string;
            fileName?: string;
            mimeType?: string;
            fileSize?: number;
          }>
        | undefined;

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
      } else if (
        msg.type === "image" ||
        msg.type === "video" ||
        msg.type === "audio" ||
        msg.type === "document" ||
        msg.type === "sticker"
      ) {
        const mediaMsg = msg as WhatsAppMediaMessage;
        const mediaPayload = mediaMsg[msg.type];
        // image, video, and document can carry a caption; audio and sticker cannot
        const caption =
          mediaMsg.image?.caption ??
          mediaMsg.video?.caption ??
          mediaMsg.document?.caption;
        body = caption?.trim() ?? "";
        mediaType = msg.type;

        if (mediaPayload?.id) {
          attachments = [
            {
              type: msg.type,
              fileId: mediaPayload.id,
              ...(mediaPayload.filename
                ? { fileName: mediaPayload.filename }
                : {}),
              ...(mediaPayload.mime_type
                ? { mimeType: mediaPayload.mime_type }
                : {}),
              ...(mediaPayload.file_size != null
                ? { fileSize: mediaPayload.file_size }
                : {}),
            },
          ];
        }
      } else {
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
        ...(mediaType ? { mediaType } : {}),
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
          message: {
            content: body,
            // Use sender phone number as the chat identifier for 1:1 conversations
            conversationExternalId: from,
            externalMessageId: msg.id,
            ...(callbackData ? { callbackData } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          },
          actor: {
            actorExternalId: from,
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
