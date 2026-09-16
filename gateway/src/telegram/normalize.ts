import { z } from "zod";

import type { ChannelConversationType } from "@vellumai/gateway-client";

import type {
  Audio,
  CallbackQuery,
  Chat,
  Document as TelegramApiDocument,
  Message,
  PhotoSize,
  Update,
  User,
  Voice,
} from "@grammyjs/types";

import type { GatewayInboundEvent } from "../types.js";
import type {
  Expect,
  ModeledKeysAreOfficial,
  OfficialValueSatisfiesOurs,
} from "../webhook-crosscheck.js";

/**
 * How visible a Telegram chat is, on the permission matrix's axis.
 *
 * `channel` is Telegram's word for a broadcast feed rather than a room, and it
 * is deliberately unmapped: nothing in the product addresses one yet, and
 * calling it public would let a rule written for conversational rooms govern a
 * surface that is not a conversation.
 *
 * @see https://core.telegram.org/bots/api#chat
 */
export function telegramConversationType(
  chatType: string | undefined,
): ChannelConversationType | undefined {
  switch (chatType) {
    case "private":
      return "dm";
    case "group":
    case "supergroup":
      return "private";
    default:
      return undefined;
  }
}

// Telegram webhook payloads are untrusted external input (Telegram Bot API).
// These schemas validate the *types* of the nested fields the normalizer reads
// while staying tolerant: a malformed field collapses to `undefined` (or an
// empty string for required ids) rather than rejecting the whole update, so the
// downstream null-checks drop an unsupported message instead of forwarding a
// malformed value. Unknown keys are stripped from the parsed working copy; the
// original payload is preserved verbatim as `raw`.
const optionalNumber = () => z.number().optional().catch(undefined);
const optionalString = () => z.string().optional().catch(undefined);
const optionalBoolean = () => z.boolean().optional().catch(undefined);
/** A required id string: a missing/non-string value collapses to `""`. */
const idString = () => z.string().catch("");

const TelegramPhotoSizeSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  width: optionalNumber(),
  height: optionalNumber(),
  file_size: optionalNumber(),
});

const TelegramDocumentSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  file_name: optionalString(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramVoiceSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  duration: optionalNumber(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramAudioSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  duration: optionalNumber(),
  performer: optionalString(),
  title: optionalString(),
  file_name: optionalString(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramFromSchema = z
  .object({
    id: optionalNumber(),
    is_bot: optionalBoolean(),
    username: optionalString(),
    first_name: optionalString(),
    last_name: optionalString(),
    language_code: optionalString(),
  })
  .optional()
  .catch(undefined);

const TelegramMessageSchema = z.object({
  message_id: optionalNumber(),
  message_thread_id: optionalNumber(),
  text: optionalString(),
  caption: optionalString(),
  chat: z
    .object({ id: optionalNumber(), type: optionalString() })
    .optional()
    .catch(undefined),
  from: TelegramFromSchema,
  photo: z.array(TelegramPhotoSizeSchema).optional().catch(undefined),
  document: TelegramDocumentSchema.optional().catch(undefined),
  voice: TelegramVoiceSchema.optional().catch(undefined),
  audio: TelegramAudioSchema.optional().catch(undefined),
});
type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

/**
 * Topic thread id of a private-chat message, as a string, or undefined for
 * messages outside a topic. Callers run after the DM-only guard, so a thread
 * id here always identifies a private-chat topic.
 */
function threadIdFromMessage(message: TelegramMessage): string | undefined {
  return message.message_thread_id != null
    ? String(message.message_thread_id)
    : undefined;
}

const TelegramCallbackQuerySchema = z.object({
  id: idString(),
  from: TelegramFromSchema,
  message: TelegramMessageSchema.optional().catch(undefined),
  data: optionalString(),
});

const TelegramUpdateSchema = z.object({
  update_id: optionalNumber(),
  message: TelegramMessageSchema.optional().catch(undefined),
  edited_message: TelegramMessageSchema.optional().catch(undefined),
  callback_query: TelegramCallbackQuerySchema.optional().catch(undefined),
});

/**
 * Why an update produced no event. Each names the check that failed, so one
 * logged drop is the whole diagnosis.
 *
 * `chat_not_private` is the deliberate scope of this integration: private
 * chats only, with groups and supergroups a future explicit opt-in. Every
 * other reason is a shape the normalizer cannot read.
 */
export type TelegramDropReason =
  | "malformed_update"
  | "missing_update_id"
  | "missing_chat"
  | "chat_not_private"
  | "missing_sender"
  | "no_supported_content"
  | "callback_without_message"
  | "callback_without_data";

export type TelegramNormalization =
  | { dropped: false; event: GatewayInboundEvent }
  | {
      dropped: true;
      reason: TelegramDropReason;
      /** Telegram's own word for the chat, when the update named one. */
      chatType: string | undefined;
      /** The chat the update belongs to, when it named one. */
      chatId: string | undefined;
    };

function drop(
  reason: TelegramDropReason,
  chat?: { id?: number; type?: string },
): TelegramNormalization {
  return {
    dropped: true,
    reason,
    chatType: chat?.type,
    chatId: chat?.id != null ? String(chat.id) : undefined,
  };
}

/**
 * Normalize a Telegram webhook payload into a GatewayInboundEvent, or say
 * why it could not be. A drop is never silent: the route logs the reason
 * before acknowledging the update.
 */
export function normalizeTelegramUpdate(
  payload: Record<string, unknown>,
): TelegramNormalization {
  const parsed = TelegramUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return drop("malformed_update");
  }
  const update = parsed.data;
  const updateId = update.update_id;

  // Handle callback_query updates (inline button clicks)
  if (update.callback_query) {
    const cbq = update.callback_query;

    // A callback_query with no message is an inline-mode edge case.
    if (!cbq.message?.chat?.id) {
      return drop("callback_without_message", cbq.message?.chat);
    }
    if (updateId == null) {
      return drop("missing_update_id", cbq.message.chat);
    }

    const chatId = String(cbq.message.chat.id);
    const chatType = cbq.message.chat.type;

    // v1 is DM-only: reject callback queries from groups/channels
    if (chatType !== "private") {
      return drop("chat_not_private", cbq.message.chat);
    }

    // Skip if there is no callback data to forward
    if (!cbq.data) {
      return drop("callback_without_data", cbq.message.chat);
    }

    // Drop the update if the sender identity cannot be determined
    if (!cbq.from?.id) {
      return drop("missing_sender", cbq.message.chat);
    }

    const actorExternalId = String(cbq.from.id);
    const callbackThreadId = threadIdFromMessage(cbq.message);

    const displayName = [cbq.from?.first_name, cbq.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();

    const event: GatewayInboundEvent = {
      version: "v1",
      sourceChannel: "telegram",
      receivedAt: new Date().toISOString(),
      message: {
        eventKind: "button",
        content: cbq.data,
        conversationExternalId: chatId,
        externalMessageId: String(updateId),
        callbackQueryId: cbq.id,
        callbackData: cbq.data,
      },
      actor: {
        actorExternalId,
        username: cbq.from?.username,
        displayName: displayName || undefined,
        firstName: cbq.from?.first_name,
        lastName: cbq.from?.last_name,
        languageCode: cbq.from?.language_code,
        isBot: cbq.from?.is_bot,
      },
      source: {
        updateId: String(updateId),
        messageId:
          cbq.message.message_id != null
            ? String(cbq.message.message_id)
            : undefined,
        chatType: cbq.message.chat.type,
        // Non-private chats were rejected above, so one human reader is proven.
        isDirectMessage: true,
        ...(telegramConversationType(cbq.message.chat.type)
          ? {
              conversationType: telegramConversationType(cbq.message.chat.type),
            }
          : {}),
        ...(callbackThreadId ? { threadId: callbackThreadId } : {}),
      },
      raw: payload,
    };
    return { dropped: false, event };
  }

  const isEdit = !update.message && !!update.edited_message;
  const message = update.message ?? update.edited_message;

  if (!message?.chat?.id) {
    return drop("missing_chat", message?.chat);
  }
  if (updateId == null) {
    return drop("missing_update_id", message.chat);
  }

  // v1 is DM-only. Checked before content so a group message reports the
  // scope it fell outside of, not the shape of what it carried.
  if (message.chat.type !== "private") {
    return drop("chat_not_private", message.chat);
  }

  // Drop the update if the sender identity cannot be determined
  if (!message.from?.id) {
    return drop("missing_sender", message.chat);
  }

  const hasContent = !!(
    message.text ||
    message.photo ||
    message.document ||
    message.voice ||
    message.audio
  );
  if (!hasContent) {
    return drop("no_supported_content", message.chat);
  }

  const actorExternalId = String(message.from.id);

  const displayName = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  const topicThreadId = threadIdFromMessage(message);

  const content = message.text || message.caption || "";

  const attachments: {
    type: "photo" | "document" | "audio";
    fileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
  }[] = [];
  if (message.photo && message.photo.length > 0) {
    // Telegram sends multiple sizes; pick the largest (last in array)
    const largest = message.photo[message.photo.length - 1];
    attachments.push({
      type: "photo",
      fileId: largest.file_id,
      fileSize: largest.file_size,
    });
  }
  if (message.document) {
    attachments.push({
      type: "document",
      fileId: message.document.file_id,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
      fileSize: message.document.file_size,
    });
  }
  if (message.voice) {
    attachments.push({
      type: "audio",
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type,
      fileSize: message.voice.file_size,
    });
  }
  if (message.audio) {
    attachments.push({
      type: "audio",
      fileId: message.audio.file_id,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type,
      fileSize: message.audio.file_size,
    });
  }

  const event: GatewayInboundEvent = {
    version: "v1",
    sourceChannel: "telegram",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: isEdit ? "edit" : "message",
      content,
      conversationExternalId: String(message.chat.id),
      externalMessageId: String(updateId),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    actor: {
      actorExternalId,
      username: message.from?.username,
      displayName: displayName || undefined,
      firstName: message.from?.first_name,
      lastName: message.from?.last_name,
      languageCode: message.from?.language_code,
      isBot: message.from?.is_bot,
    },
    source: {
      updateId: String(updateId),
      messageId:
        message.message_id != null ? String(message.message_id) : undefined,
      chatType: message.chat.type,
      // Non-private chats were rejected above, so one human reader is proven.
      isDirectMessage: true,
      ...(telegramConversationType(message.chat.type)
        ? { conversationType: telegramConversationType(message.chat.type) }
        : {}),
      ...(topicThreadId ? { threadId: topicThreadId } : {}),
    },
    raw: payload,
  };
  return { dropped: false, event };
}

// ---------------------------------------------------------------------------
// Compile-time cross-check against the official Telegram Bot API types.
//
// `@grammyjs/types` is a types-only dev dependency: it contributes nothing at
// runtime (the `import type` above is erased from the build) and the schemas
// above stay the sole runtime validators. Its only job is to make TypeScript
// prove, via the shared `webhook-crosscheck` helpers, that a drift from the
// real Bot API shape fails `tsc` instead of silently mis-parsing a live
// webhook — e.g. a field-name typo like `messsage_thread_id` (which would
// otherwise always parse to `undefined`) or a wrong primitive (`chat.id` as a
// string).
type TelegramFrom = NonNullable<z.infer<typeof TelegramFromSchema>>;
type TelegramChat = NonNullable<TelegramMessage["chat"]>;

type _TelegramApiCrossChecks = [
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramUpdateSchema>, Update>>,
  Expect<
    OfficialValueSatisfiesOurs<z.infer<typeof TelegramUpdateSchema>, Update>
  >,
  Expect<ModeledKeysAreOfficial<TelegramMessage, Message>>,
  Expect<OfficialValueSatisfiesOurs<TelegramMessage, Message>>,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof TelegramCallbackQuerySchema>,
      CallbackQuery
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      z.infer<typeof TelegramCallbackQuerySchema>,
      CallbackQuery
    >
  >,
  Expect<ModeledKeysAreOfficial<TelegramChat, Chat>>,
  Expect<ModeledKeysAreOfficial<TelegramFrom, User>>,
  Expect<
    ModeledKeysAreOfficial<z.infer<typeof TelegramPhotoSizeSchema>, PhotoSize>
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof TelegramDocumentSchema>,
      TelegramApiDocument
    >
  >,
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramVoiceSchema>, Voice>>,
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramAudioSchema>, Audio>>,
];
