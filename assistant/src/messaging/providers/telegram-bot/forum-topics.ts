/**
 * Telegram Private Chat Topics helpers (create/edit + title echo-guard).
 */

import { getLogger } from "../../../util/logger.js";
import { callTelegramBotApi } from "./api.js";

const log = getLogger("telegram-forum-topics");

const ECHO_GUARD_TTL_MS = 15_000;
const echoGuard = new Map<string, number>();

function echoKey(chatId: string, threadId: string, name: string): string {
  return `${chatId}:${threadId}:${name}`;
}

export function rememberTelegramTopicRename(
  chatId: string,
  threadId: string,
  name: string,
): void {
  echoGuard.set(
    echoKey(chatId, threadId, name),
    Date.now() + ECHO_GUARD_TTL_MS,
  );
}

export function shouldSkipTelegramTopicRenameEcho(
  chatId: string,
  threadId: string,
  name: string,
): boolean {
  const key = echoKey(chatId, threadId, name);
  const expiresAt = echoGuard.get(key);
  if (expiresAt == null) {
    return false;
  }
  if (Date.now() > expiresAt) {
    echoGuard.delete(key);
    return false;
  }
  echoGuard.delete(key);
  return true;
}

export async function createTelegramForumTopic(params: {
  chatId: string;
  name: string;
}): Promise<{ messageThreadId: number; name: string }> {
  const trimmedName = params.name.trim().slice(0, 128);
  if (!trimmedName) {
    throw new Error("Forum topic name is required");
  }
  const result = await callTelegramBotApi<{
    message_thread_id: number;
    name: string;
  }>("createForumTopic", {
    chat_id: params.chatId,
    name: trimmedName,
  });
  log.info(
    {
      chatId: params.chatId,
      messageThreadId: result.message_thread_id,
      name: result.name,
    },
    "Created Telegram forum topic",
  );
  return {
    messageThreadId: result.message_thread_id,
    name: result.name,
  };
}

export async function editTelegramForumTopic(params: {
  chatId: string;
  messageThreadId: string;
  name: string;
}): Promise<void> {
  const trimmedName = params.name.trim().slice(0, 128);
  if (!trimmedName) {
    throw new Error("Forum topic name is required");
  }
  rememberTelegramTopicRename(
    params.chatId,
    params.messageThreadId,
    trimmedName,
  );
  await callTelegramBotApi("editForumTopic", {
    chat_id: params.chatId,
    message_thread_id: Number(params.messageThreadId),
    name: trimmedName,
  });
  log.info(
    {
      chatId: params.chatId,
      messageThreadId: params.messageThreadId,
      name: trimmedName,
    },
    "Edited Telegram forum topic",
  );
}

export async function deleteTelegramForumTopic(params: {
  chatId: string;
  messageThreadId: string;
}): Promise<void> {
  const threadId = Number(params.messageThreadId);
  if (!Number.isFinite(threadId)) {
    throw new Error("A numeric messageThreadId is required");
  }
  log.debug(
    { chatId: params.chatId, messageThreadId: params.messageThreadId },
    "Deleting Telegram forum topic",
  );
  await callTelegramBotApi("deleteForumTopic", {
    chat_id: params.chatId,
    message_thread_id: threadId,
  });
  log.info(
    { chatId: params.chatId, messageThreadId: params.messageThreadId },
    "Deleted Telegram forum topic",
  );
}
