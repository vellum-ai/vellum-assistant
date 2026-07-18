/**
 * Channel-side thread cleanup for archived conversations.
 *
 * When a conversation is archived, its bound channel thread is removed so the
 * messaging surface matches Vellum. Only bot threads (bindings carrying an
 * `externalThreadId`) are removed — a main-chat binding has no thread and is
 * left untouched, so archiving never deletes the whole DM. Best-effort: any
 * channel/API failure is logged, never thrown, so archive cannot fail on a
 * channel error.
 */

import { deleteTelegramForumTopic } from "../messaging/providers/telegram-bot/forum-topics.js";
import {
  deleteBindingByChannelChatThread,
  getBindingByConversation,
} from "../persistence/external-conversation-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("channel-thread-cleanup");

export async function deleteBoundChannelThread(
  conversationId: string,
): Promise<void> {
  const binding = getBindingByConversation(conversationId);
  const threadId = binding?.externalThreadId?.trim();
  if (!binding || !threadId || binding.sourceChannel !== "telegram") {
    return;
  }
  try {
    await deleteTelegramForumTopic({
      chatId: binding.externalChatId,
      messageThreadId: threadId,
    });
    deleteBindingByChannelChatThread(
      "telegram",
      binding.externalChatId,
      threadId,
    );
  } catch (err) {
    log.warn(
      { err, conversationId, chatId: binding.externalChatId, threadId },
      "Failed to delete bound Telegram thread on archive",
    );
  }
}
