import type { GatewayInboundEvent } from "../types.js";

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number; type?: string };
  from?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  };
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

interface TelegramCallbackQuery {
  id: string;
  from: {
    id?: number;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Normalize a Telegram webhook payload into a GatewayInboundEvent.
 * Returns null if the payload is unsupported (non-text, non-private, etc.)
 * or if the sender identity cannot be determined.
 */
export function normalizeTelegramUpdate(
  payload: Record<string, unknown>,
): GatewayInboundEvent | null {
  const update = payload as TelegramUpdate;
  const updateId = update.update_id;

  // Handle callback_query updates (inline button clicks)
  if (update.callback_query) {
    const cbq = update.callback_query;

    // Skip if callback_query has no message (edge case, e.g. inline mode)
    if (!cbq.message?.chat?.id || updateId == null) {
      return null;
    }

    // Skip if there is no callback data to forward
    if (!cbq.data) {
      return null;
    }

    const chatId = String(cbq.message.chat.id);
    const chatType = cbq.message.chat.type;

    // v1 is DM-only — reject callback queries from groups/channels
    if (chatType !== "private") {
      return null;
    }

    // Drop the update if the sender identity cannot be determined
    if (!cbq.from?.id) {
      return null;
    }

    const actorExternalId = String(cbq.from.id);

    const displayName = [cbq.from?.first_name, cbq.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();

    return {
      version: "v1",
      sourceChannel: "telegram",
      receivedAt: new Date().toISOString(),
      message: {
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
      },
      raw: payload,
    };
  }

  const isEdit = !update.message && !!update.edited_message;
  const message = update.message ?? update.edited_message;

  const hasContent = !!(
    message?.text ||
    message?.photo ||
    message?.document ||
    message?.voice ||
    message?.audio
  );
  if (!hasContent || !message?.chat?.id || updateId == null) {
    return null;
  }

  // v1 is DM-only
  if (message.chat.type !== "private") {
    return null;
  }

  // Drop the update if the sender identity cannot be determined
  if (!message.from?.id) {
    return null;
  }

  const actorExternalId = String(message.from.id);

  const displayName = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

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

  return {
    version: "v1",
    sourceChannel: "telegram",
    receivedAt: new Date().toISOString(),
    message: {
      content,
      conversationExternalId: String(message.chat.id),
      externalMessageId: String(updateId),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(isEdit ? { isEdit: true } : {}),
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
    },
    raw: payload,
  };
}
