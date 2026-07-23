import { z } from "zod";

import { getLogger } from "../logger.js";
import type { GatewayInboundEvent } from "../types.js";

// WhatsApp Cloud API webhook payloads are untrusted external input:
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
//
// The envelope and each message are validated with Zod. The routing fields a
// message is keyed on (`id` for dedup/identity, `from` for sender/conversation)
// are required — a message missing either is dropped rather than processed, so
// one bad message in a batch can never take down the rest. Content-bearing
// fields (text body, button reply, media metadata) stay tolerant: a malformed
// value collapses to `undefined` rather than rejecting the whole message. Fields
// the normalizer does not consume (e.g. the provider `timestamp`) are not
// modeled; they are stripped from the parsed copy and survive only in `raw`,
// which carries the original payload verbatim.

const log = getLogger("whatsapp-normalize");

const optionalString = () => z.string().optional().catch(undefined);
const optionalNumber = () => z.number().optional().catch(undefined);

/**
 * Routing fields present on every WhatsApp message. Required and validated:
 * `id` is the dedup key / external message id, and `from` is the sender identity
 * and conversation address. The provider `timestamp` is intentionally not
 * modeled — the event's `receivedAt` is the gateway's own receipt time (as on
 * every other channel), so the sender-supplied time is never consumed.
 */
const messageCore = {
  id: z.string().min(1),
  from: z.string().min(1),
};

const mediaPayloadSchema = z.object({
  caption: optionalString(),
  mime_type: optionalString(),
  id: optionalString(),
  file_size: optionalNumber(),
  filename: optionalString(),
});

const textMessageSchema = z.object({
  ...messageCore,
  type: z.literal("text"),
  text: z.object({ body: optionalString() }).optional().catch(undefined),
});

const interactiveMessageSchema = z.object({
  ...messageCore,
  type: z.literal("interactive"),
  interactive: z
    .object({
      type: optionalString(),
      button_reply: z
        .object({ id: optionalString(), title: optionalString() })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const imageMessageSchema = z.object({
  ...messageCore,
  type: z.literal("image"),
  image: mediaPayloadSchema.optional().catch(undefined),
});

const videoMessageSchema = z.object({
  ...messageCore,
  type: z.literal("video"),
  video: mediaPayloadSchema.optional().catch(undefined),
});

const audioMessageSchema = z.object({
  ...messageCore,
  type: z.literal("audio"),
  audio: mediaPayloadSchema.optional().catch(undefined),
});

const documentMessageSchema = z.object({
  ...messageCore,
  type: z.literal("document"),
  document: mediaPayloadSchema.optional().catch(undefined),
});

const stickerMessageSchema = z.object({
  ...messageCore,
  type: z.literal("sticker"),
  sticker: mediaPayloadSchema.optional().catch(undefined),
});

const whatsAppMessageSchema = z.discriminatedUnion("type", [
  textMessageSchema,
  interactiveMessageSchema,
  imageMessageSchema,
  videoMessageSchema,
  audioMessageSchema,
  documentMessageSchema,
  stickerMessageSchema,
]);
type WhatsAppMessage = z.infer<typeof whatsAppMessageSchema>;

/** The message types this normalizer produces events for, from the union above. */
const HANDLED_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  whatsAppMessageSchema.options.map((option) => option.shape.type.value),
);

const contactSchema = z.object({
  profile: z.object({ name: optionalString() }).optional().catch(undefined),
  wa_id: optionalString(),
});

const valueSchema = z.object({
  messaging_product: optionalString(),
  metadata: z
    .object({
      phone_number_id: optionalString(),
      display_phone_number: optionalString(),
    })
    .optional()
    .catch(undefined),
  contacts: z.array(contactSchema).optional().catch(undefined),
  // Individual messages are parsed per-item in the loop so one malformed
  // message drops on its own rather than failing the whole array.
  messages: z.array(z.unknown()).optional().catch(undefined),
  // statuses are delivery/read receipts — parsed loosely and ignored.
  statuses: z.array(z.unknown()).optional().catch(undefined),
});

const changeSchema = z.object({
  field: optionalString(),
  value: valueSchema.optional().catch(undefined),
});

const entrySchema = z.object({
  id: optionalString(),
  changes: z.array(changeSchema).optional().catch(undefined),
});

const whatsAppWebhookSchema = z.object({
  object: optionalString(),
  entry: z.array(entrySchema).optional().catch(undefined),
});

export interface NormalizedWhatsAppMessage {
  event: GatewayInboundEvent;
  /** Original WhatsApp message ID — used for marking as read. */
  whatsappMessageId: string;
  /** The media type when the message contained an attachment (image, video, etc.). */
  mediaType?: string;
}

type WhatsAppMediaMessage = Extract<
  WhatsAppMessage,
  { type: "image" | "video" | "audio" | "document" | "sticker" }
>;

/** The media payload carried under the key matching the message's type. */
function mediaPayloadOf(msg: WhatsAppMediaMessage) {
  switch (msg.type) {
    case "image":
      return msg.image;
    case "video":
      return msg.video;
    case "audio":
      return msg.audio;
    case "document":
      return msg.document;
    case "sticker":
      return msg.sticker;
  }
}

/** The `type` of a raw message that failed validation, if it is a string. */
function rawMessageType(rawMsg: unknown): string | undefined {
  if (
    rawMsg &&
    typeof rawMsg === "object" &&
    "type" in rawMsg &&
    typeof (rawMsg as { type: unknown }).type === "string"
  ) {
    return (rawMsg as { type: string }).type;
  }
  return undefined;
}

/**
 * Normalize a WhatsApp Cloud API webhook payload into an array of GatewayInboundEvent events.
 *
 * Returns an empty array if the payload is not a WhatsApp messages webhook.
 *
 * Media messages (image/video/audio/document/sticker) are normalized with any
 * accompanying caption as the message content. The `mediaType` field is set so
 * the caller can log that media content itself was not processed.
 *
 * Meta may batch multiple messages in a single webhook payload; every valid
 * message is processed. A message that fails validation is dropped individually
 * (and, when its type is one we handle, logged) so it cannot discard the batch.
 */
export function normalizeWhatsAppWebhook(
  payload: Record<string, unknown>,
): NormalizedWhatsAppMessage[] {
  const parsed = whatsAppWebhookSchema.safeParse(payload);
  if (!parsed.success) return [];
  const wh = parsed.data;

  if (wh.object !== "whatsapp_business_account") return [];

  // One receipt time for the whole webhook — the gateway's wall clock, like
  // every other channel. The sender-supplied `timestamp` is not trusted for this.
  const receivedAt = new Date().toISOString();

  const results: NormalizedWhatsAppMessage[] = [];

  for (const entry of wh.entry ?? []) {
    const change = entry.changes?.find((c) => c.field === "messages");
    if (!change?.value) continue;

    const value = change.value;
    const messages = value.messages;
    if (!messages || messages.length === 0) continue;

    for (const rawMsg of messages) {
      const parsedMsg = whatsAppMessageSchema.safeParse(rawMsg);
      if (!parsedMsg.success) {
        const rawType = rawMessageType(rawMsg);
        // A valid WhatsApp message of a type we don't produce events for
        // (location, reaction, order, …) is skipped quietly. Only a message
        // whose type we *do* handle but that failed validation — or one with no
        // usable type at all — is malformed and worth a warning.
        if (rawType && !HANDLED_MESSAGE_TYPES.has(rawType)) continue;
        log.warn(
          { messageType: rawType },
          "Dropping malformed WhatsApp message",
        );
        continue;
      }
      const msg = parsedMsg.data;

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
        body = msg.text?.body?.trim() ?? "";
      } else if (msg.type === "interactive") {
        // Interactive button reply — extract the button ID as callback data
        if (msg.interactive?.type !== "button_reply") continue;
        const buttonReply = msg.interactive.button_reply;
        if (!buttonReply?.id) continue;
        callbackData = buttonReply.id;
        body = buttonReply.title ?? "";
      } else {
        const mediaPayload = mediaPayloadOf(msg);
        // image, video, and document can carry a caption; audio and sticker cannot
        body = mediaPayload?.caption?.trim() ?? "";
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
      }

      // from is the sender's WhatsApp phone number in E.164 format
      const from = msg.from;

      // Resolve display name from contacts array when available
      const contact = value.contacts?.find((c) => c.wa_id === from);
      const displayName = contact?.profile?.name ?? from;

      results.push({
        whatsappMessageId: msg.id,
        ...(mediaType ? { mediaType } : {}),
        event: {
          version: "v1",
          sourceChannel: "whatsapp",
          receivedAt,
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
