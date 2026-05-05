import { getMessages, type MessageRow } from "../memory/conversation-crud.js";
import { cleanupBootstrapFiles } from "../prompts/bootstrap-cleanup.js";
import { getLogger } from "../util/logger.js";

export const BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD = 4;

const log = getLogger("bootstrap-turn-cleanup");

function isWakeUpGreetingMessage(content: string): boolean {
  return content.toLowerCase().includes("wake up, my friend");
}

export function countBootstrapUserTurns(
  messages: Pick<MessageRow, "role" | "content">[],
): number {
  return messages.filter(
    (message) =>
      message.role === "user" && !isWakeUpGreetingMessage(message.content),
  ).length;
}

export function shouldCleanupBootstrapAfterTurn(
  messages: Pick<MessageRow, "role" | "content">[],
  threshold = BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD,
): boolean {
  return countBootstrapUserTurns(messages) >= threshold;
}

export function cleanupBootstrapAfterTurnThreshold(
  conversationId: string,
): boolean {
  let messages: MessageRow[];
  try {
    messages = getMessages(conversationId);
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to inspect bootstrap turn count");
    return false;
  }

  if (!shouldCleanupBootstrapAfterTurn(messages)) return false;

  return cleanupBootstrapFiles(
    `first conversation reached ${BOOTSTRAP_CLEANUP_USER_TURN_THRESHOLD} user turns`,
  );
}
