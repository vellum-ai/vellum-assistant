/**
 * Threaded-mode-aware verification delivery for Telegram.
 *
 * When the bot has forum topic mode enabled (@BotFather "Threaded mode",
 * surfaced as `User.has_topics_enabled` on getMe), verification runs inside a
 * dedicated, freshly-created "Verification" topic rather than the main chat.
 * The topic is deleted after a successful verification (gateway-side, keyed on
 * the inbound reply's thread id). When threaded mode is off, delivery falls
 * back to the main chat unchanged.
 */

import { getLogger } from "../../../util/logger.js";
import { callTelegramBotApi } from "./api.js";
import { createTelegramForumTopic } from "./forum-topics.js";

const log = getLogger("telegram-verification-topic");

const VERIFICATION_TOPIC_NAME = "Verification";

// Threaded mode is a bot-level @BotFather setting that changes rarely; a short
// TTL keeps a toggle from taking effect too slowly while avoiding a getMe call
// on every verification.
const HAS_TOPICS_CACHE_TTL_MS = 60_000;

let hasTopicsCache: { value: boolean; expiresAt: number } | null = null;

/**
 * Invalidate the cached threaded-mode capability. Call when the bot token
 * changes (a different bot may have a different setting) or the setting is
 * toggled, so the next verification re-reads getMe instead of waiting out the
 * TTL.
 */
export function resetTelegramThreadedModeCache(): void {
  hasTopicsCache = null;
}

/**
 * Whether the bot has forum topic mode ("Threaded mode") enabled, read from
 * `getMe().has_topics_enabled` and cached for a short window. On a getMe
 * failure the last known value is reused (defaulting to `false`) so a
 * transient outage never spuriously creates topics.
 */
export async function isTelegramThreadedModeEnabled(): Promise<boolean> {
  const now = Date.now();
  if (hasTopicsCache && now < hasTopicsCache.expiresAt) {
    return hasTopicsCache.value;
  }

  log.debug("Resolving Telegram threaded mode via getMe");
  try {
    const me = await callTelegramBotApi<{ has_topics_enabled?: boolean }>(
      "getMe",
      {},
    );
    const value = me.has_topics_enabled === true;
    hasTopicsCache = { value, expiresAt: now + HAS_TOPICS_CACHE_TTL_MS };
    log.info({ enabled: value }, "Resolved Telegram threaded mode");
    return value;
  } catch (err) {
    log.warn(
      { err },
      "Failed to resolve Telegram threaded mode via getMe; assuming last known value",
    );
    return hasTopicsCache?.value ?? false;
  }
}

/**
 * Resolve the Telegram thread to run verification in for the given chat.
 *
 * In threaded mode, creates a fresh "Verification" topic and returns its
 * thread id so the caller can deliver the code there. Returns `undefined`
 * (main chat) when threaded mode is off or the topic could not be created.
 */
export async function resolveVerificationThreadId(
  chatId: string,
): Promise<string | undefined> {
  if (!(await isTelegramThreadedModeEnabled())) {
    return undefined;
  }

  log.debug({ chatId }, "Creating Telegram verification topic");
  try {
    const topic = await createTelegramForumTopic({
      chatId,
      name: VERIFICATION_TOPIC_NAME,
    });
    return String(topic.messageThreadId);
  } catch (err) {
    log.warn(
      { err, chatId },
      "Failed to create Telegram verification topic; delivering in main chat",
    );
    return undefined;
  }
}
