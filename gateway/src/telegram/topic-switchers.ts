/**
 * Live selection switchers for Telegram Private Chat Topics.
 *
 * A "switcher" is an inline-keyboard message the bot posts in response to
 * `/profile` or `/access`. At most one switcher stays live per (chat, thread):
 * posting a new one removes the previous message, and selecting an option
 * edits the message in place (dropping the keyboard) so no stale, clickable
 * keyboard lingers in the chat.
 *
 * State is intentionally ephemeral (in-memory). A single message id per
 * (chat, thread) is all that is tracked; nothing here persists across restart.
 */

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { getLogger } from "../logger.js";
import { callTelegramApi } from "./api.js";

const log = getLogger("telegram-topic-switchers");

/** Drop a tracked switcher this long after it was posted if never resolved. */
const SWITCHER_TTL_MS = 60 * 60 * 1000;

type Caches = { credentials?: CredentialCache; configFile?: ConfigFileCache };

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

interface SwitcherEntry {
  messageId: number;
  expiresAt: number;
}

const switchers = new Map<string, SwitcherEntry>();

function switcherKey(chatId: string, threadId?: string): string {
  return `${chatId}:${threadId ?? ""}`;
}

function takeSwitcher(chatId: string, threadId?: string): number | null {
  const key = switcherKey(chatId, threadId);
  const entry = switchers.get(key);
  if (!entry) {
    return null;
  }
  switchers.delete(key);
  if (Date.now() > entry.expiresAt) {
    return null;
  }
  return entry.messageId;
}

/**
 * Post a selection switcher, first removing any switcher already open in the
 * same chat/topic so only one stays live per (chat, thread).
 */
export async function sendTopicSwitcher(params: {
  caches?: Caches;
  chatId: string;
  threadId?: string;
  text: string;
  keyboard: InlineKeyboard;
}): Promise<void> {
  const { caches, chatId, threadId, text, keyboard } = params;

  const previousMessageId = takeSwitcher(chatId, threadId);
  if (previousMessageId != null) {
    await callTelegramApi(
      "deleteMessage",
      { chat_id: chatId, message_id: previousMessageId },
      caches,
    ).catch((err) => {
      log.debug(
        { err, chatId, threadId, messageId: previousMessageId },
        "Failed to delete previous topic switcher",
      );
    });
  }

  const sent = await callTelegramApi<{ message_id: number }>(
    "sendMessage",
    {
      chat_id: chatId,
      text,
      reply_markup: keyboard,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    },
    caches,
  );

  switchers.set(switcherKey(chatId, threadId), {
    messageId: sent.message_id,
    expiresAt: Date.now() + SWITCHER_TTL_MS,
  });
}

/**
 * Resolve a switcher after a selection: drop the tracked entry and edit the
 * message in place to `text`, which also removes the inline keyboard (an
 * `editMessageText` without `reply_markup` clears the buttons).
 */
export async function resolveTopicSwitcher(params: {
  caches?: Caches;
  chatId: string;
  threadId?: string;
  messageId: string | undefined;
  text: string;
}): Promise<void> {
  const { caches, chatId, threadId, messageId, text } = params;

  switchers.delete(switcherKey(chatId, threadId));

  if (!messageId) {
    return;
  }
  const parsedMessageId = Number(messageId);
  if (!Number.isFinite(parsedMessageId)) {
    return;
  }

  await callTelegramApi(
    "editMessageText",
    { chat_id: chatId, message_id: parsedMessageId, text },
    caches,
  ).catch((err) => {
    log.debug(
      { err, chatId, threadId, messageId: parsedMessageId },
      "Failed to edit topic switcher message on resolve",
    );
  });
}
