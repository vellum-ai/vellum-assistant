import type { ApprovalUIMetadata } from "@vellumai/gateway-client";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { getLogger } from "../logger.js";
import { splitText } from "../util/split-text.js";
import { callTelegramApi } from "./api.js";

const log = getLogger("telegram-send");

const TELEGRAM_MAX_MESSAGE_LEN = 4000;

/** Telegram Bot API enforces a 1-64 byte limit on InlineKeyboardButton callback_data. */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

export function buildInlineKeyboard(approval: ApprovalUIMetadata): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: approval.actions.map((action) => {
      const callbackData = `apr:${approval.requestId}:${action.id}`;
      if (Buffer.byteLength(callbackData) > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
        throw new Error(
          `callback_data for action "${action.id}" is ${Buffer.byteLength(callbackData)} bytes, exceeding Telegram's ${TELEGRAM_MAX_CALLBACK_DATA_BYTES}-byte limit`,
        );
      }
      return [
        {
          text: action.label,
          callback_data: callbackData,
        },
      ];
    }),
  };
}

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
  approval?: ApprovalUIMetadata,
  opts?: {
    credentials?: CredentialCache;
    configFile?: ConfigFileCache;
    /** Topic (private-chat or forum) to send into; omitted → main chat. */
    messageThreadId?: string;
  },
): Promise<void> {
  const chunks = splitText(text, TELEGRAM_MAX_MESSAGE_LEN);
  const messageThreadId = opts?.messageThreadId?.trim();

  for (let i = 0; i < chunks.length; i++) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
    };

    // message_thread_id is the Bot API topic field for both forum supergroups
    // and private chats of bots with topic ("threaded") mode enabled.
    // (direct_messages_topic_id is a different surface — channel monoforums.)
    if (messageThreadId) {
      payload.message_thread_id = Number(messageThreadId);
    }

    // Attach inline keyboard only to the last chunk so buttons appear after
    // the full message text.
    if (approval && i === chunks.length - 1) {
      payload.reply_markup = buildInlineKeyboard(approval);
    }

    await callTelegramApi("sendMessage", payload, opts);
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
}

export async function sendTypingIndicator(
  config: GatewayConfig,
  chatId: string,
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<boolean> {
  try {
    await callTelegramApi(
      "sendChatAction",
      {
        chat_id: chatId,
        action: "typing",
      },
      opts,
    );
    return true;
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
    return false;
  }
}
