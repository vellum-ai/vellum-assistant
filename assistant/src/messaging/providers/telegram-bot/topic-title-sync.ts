/**
 * Sync Vellum conversation titles to Telegram Private Chat Topics.
 */

import { getBindingByConversation } from "../../../persistence/external-conversation-store.js";
import { getLogger } from "../../../util/logger.js";
import { editTelegramForumTopic } from "./forum-topics.js";

const log = getLogger("telegram-topic-title-sync");

/**
 * When a conversation title changes and the binding is a Telegram topic,
 * push the name to Telegram via editForumTopic. Plain DM bindings (null
 * thread) are a no-op.
 */
export async function syncConversationTitleToTelegramTopic(
  conversationId: string,
  title: string,
): Promise<void> {
  const binding = getBindingByConversation(conversationId);
  if (!binding || binding.sourceChannel !== "telegram") {
    return;
  }
  const threadId = binding.externalThreadId?.trim();
  if (!threadId) {
    return;
  }
  const chatId = binding.externalChatId?.trim();
  if (!chatId) {
    return;
  }
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return;
  }

  try {
    await editTelegramForumTopic({
      chatId,
      messageThreadId: threadId,
      name: trimmedTitle,
    });
  } catch (err) {
    log.warn(
      { err, conversationId, chatId, threadId },
      "Failed to sync conversation title to Telegram topic",
    );
  }
}
