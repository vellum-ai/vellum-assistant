import type { ChannelConversationType } from "@vellumai/gateway-client";

import type { RoomAdmissionDropReason } from "../channels/room-admission.js";
import type { GatewayInboundEvent } from "../types.js";
import { admitTelegramMessage, toAdmissionCandidate } from "./admit.js";
import type { TelegramBotIdentity } from "./bot-identity.js";
import {
  type TelegramMessage,
  type TelegramMessageEntity,
  TelegramUpdateSchema,
} from "./schemas.js";

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

/**
 * Topic thread id of a message, as a string, or undefined for messages
 * outside a topic.
 *
 * In a private chat a `message_thread_id` is always a topic, because that is
 * the only thread a private chat has. In a supergroup the same field also
 * names a reply chain, which is one conversation rather than many, so a room
 * message forks a conversation only when Telegram says it is a topic
 * (`is_topic_message`, set for forum topics and for private-chat topics
 * alike).
 */
function threadIdFromMessage(message: TelegramMessage): string | undefined {
  if (message.message_thread_id == null) {
    return undefined;
  }
  const inTopic =
    message.chat?.type === "private" || message.is_topic_message === true;
  return inTopic ? String(message.message_thread_id) : undefined;
}

/**
 * The text with a leading `/command@username` addressed to this bot reduced
 * to `/command`, so the route's command parsers see the same spelling a
 * private chat sends. Telegram appends the username in groups to say which
 * bot a command is for; it is addressing, not content, the way a leading
 * Slack mention is. Any other text is returned as is.
 */
function withoutOwnCommandSuffix(
  text: string,
  entities: TelegramMessageEntity[],
  botUsername: string | undefined,
): string {
  if (botUsername === undefined) {
    return text;
  }
  const command = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (command?.length == null) {
    return text;
  }
  const span = text.slice(0, command.length);
  const at = span.indexOf("@");
  if (at === -1) {
    return text;
  }
  if (span.slice(at + 1).toLowerCase() !== botUsername.toLowerCase()) {
    return text;
  }
  return span.slice(0, at) + text.slice(command.length);
}

/**
 * Why an update produced no event. Each names the check that failed, so one
 * logged drop is the whole diagnosis.
 *
 * The admission reasons are the gate's (`admit.ts`): a room message that
 * did not address the bot, a chat kind nothing in the product serves, a bot
 * that does not yet know its own name. Every other reason is a shape the
 * normalizer cannot read.
 */
export type TelegramDropReason =
  | RoomAdmissionDropReason
  | "malformed_update"
  | "missing_update_id"
  | "missing_chat"
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
 * The chat kind an update belongs to, read before normalization so the
 * route can decide whether it needs the bot's identity at all: only a group
 * or supergroup is admitted on a mention, so a private-only deployment never
 * pays the `getMe` call.
 */
export function telegramUpdateChatType(
  payload: Record<string, unknown>,
): string | undefined {
  const parsed = TelegramUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const update = parsed.data;
  return (
    update.callback_query?.message?.chat?.type ??
    update.message?.chat?.type ??
    update.edited_message?.chat?.type
  );
}

export interface TelegramNormalizeOptions {
  /**
   * Who the bot is, for the admission gate to recognise a room message that
   * addresses it. Absent, every room message drops as `bot_identity_unknown`
   * and private chats are unaffected.
   */
  bot?: TelegramBotIdentity;
}

/**
 * Normalize a Telegram webhook payload into a GatewayInboundEvent, or say
 * why it could not be. A drop is never silent: the route logs the reason
 * before acknowledging the update.
 *
 * Admission runs here too, between parsing and building: the gate reads the
 * parsed entities, and a denied message is a drop like any other.
 */
export function normalizeTelegramUpdate(
  payload: Record<string, unknown>,
  options: TelegramNormalizeOptions = {},
): TelegramNormalization {
  const policy = {
    ...(options.bot ? { botUserId: options.bot.userId } : {}),
    ...(options.bot?.username ? { botUsername: options.bot.username } : {}),
  };
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

    // A button press needs no mention: the bot posted the keyboard, so a tap
    // on it is addressed to the bot by construction. Who may press it is the
    // runtime's decision, keyed on the actor. Only the chat kind is gated.
    if (
      chatType !== "private" &&
      chatType !== "group" &&
      chatType !== "supergroup"
    ) {
      return drop("chat_not_supported", cbq.message.chat);
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
        // Readership is proven either way: a private chat has one human
        // reader and a group has more.
        isDirectMessage: chatType === "private",
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

  // Drop the update if the sender identity cannot be determined
  if (!message.from?.id) {
    return drop("missing_sender", message.chat);
  }

  // Admission before content, so a room message that did not address the
  // bot reports that, not the shape of what it carried.
  const verdict = admitTelegramMessage(toAdmissionCandidate(message), policy);
  if (!verdict.admitted) {
    return drop(verdict.reason, message.chat);
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

  const content = message.text
    ? withoutOwnCommandSuffix(
        message.text,
        message.entities ?? [],
        options.bot?.username,
      )
    : message.caption || "";

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
      // Readership is proven either way: a private chat has one human reader
      // and a group has more.
      isDirectMessage: message.chat.type === "private",
      botMentioned: verdict.botMentioned,
      ...(telegramConversationType(message.chat.type)
        ? { conversationType: telegramConversationType(message.chat.type) }
        : {}),
      ...(topicThreadId ? { threadId: topicThreadId } : {}),
    },
    raw: payload,
  };
  return { dropped: false, event };
}
