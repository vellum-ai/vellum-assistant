import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { getLogger } from "../logger.js";
import { splitText } from "../util/split-text.js";
import { callTelegramApi } from "./api.js";

const log = getLogger("telegram-send");

const TELEGRAM_MAX_MESSAGE_LEN = 4000;

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
  opts?: {
    credentials?: CredentialCache;
    configFile?: ConfigFileCache;
    /** Topic (private-chat or forum) to send into; omitted → main chat. */
    messageThreadId?: string;
  },
): Promise<void> {
  const chunks = splitText(text, TELEGRAM_MAX_MESSAGE_LEN);
  const messageThreadId = opts?.messageThreadId?.trim();

  for (const chunk of chunks) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
    };

    // message_thread_id is the Bot API topic field for both forum supergroups
    // and private chats of bots with topic ("threaded") mode enabled.
    // (direct_messages_topic_id is a different surface — channel monoforums.)
    if (messageThreadId) {
      payload.message_thread_id = Number(messageThreadId);
    }

    await callTelegramApi("sendMessage", payload, opts);
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
}
