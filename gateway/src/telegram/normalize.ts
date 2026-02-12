import type { GatewayInboundEventV1 } from "../types.js";

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
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

/**
 * Normalize a Telegram webhook payload into a GatewayInboundEventV1.
 * Returns null if the payload is unsupported (non-text, non-private, etc.).
 */
export function normalizeTelegramUpdate(
  payload: Record<string, unknown>,
): Omit<GatewayInboundEventV1, "routing"> | null {
  const update = payload as TelegramUpdate;
  const message = update.message;
  const updateId = update.update_id;

  if (!message?.text || !message?.chat?.id || updateId == null) {
    return null;
  }

  // v1 is DM-only
  if (message.chat.type !== "private") {
    return null;
  }

  const externalUserId = message.from?.id
    ? String(message.from.id)
    : String(message.chat.id);

  const displayName = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    version: "v1",
    sourceChannel: "telegram",
    receivedAt: new Date().toISOString(),
    message: {
      content: message.text,
      externalChatId: String(message.chat.id),
      externalMessageId: String(updateId),
    },
    sender: {
      externalUserId,
      username: message.from?.username,
      displayName: displayName || undefined,
      firstName: message.from?.first_name,
      lastName: message.from?.last_name,
      languageCode: message.from?.language_code,
      isBot: message.from?.is_bot,
    },
    source: {
      updateId: String(updateId),
      messageId: message.message_id != null ? String(message.message_id) : undefined,
      chatType: message.chat.type,
    },
    raw: payload,
  };
}
