/**
 * Gate for LLM-touching background work that runs between daemon start and
 * the user's first interaction.
 *
 * ## Why this exists
 *
 * Cloud-hosted assistants are served from a warm pool: the daemon boots,
 * background services initialize, and the image waits to be claimed by a
 * real user. Before the user claims an image, no provider credentials are
 * registered, so any background job that tries to call the LLM fails — and
 * those failure rows persist in the local SQLite database, becoming visible
 * in the conversation sidebar the moment the user hatches.
 *
 * ## The probe
 *
 * `hasReceivedUserMessage()` returns `true` once at least one
 * `role='user'` message exists in a `conversation_type='standard'`
 * conversation. Background / scheduled conversations don't count — they're
 * exactly the noise we're trying to suppress.
 *
 * The result is cached in-process after the first `true` because the flag
 * is monotonic: a user message, once present, is never deleted in a way
 * that should re-open the gate. (Even a destructive sweep that wipes all
 * messages would still want background jobs paused until a real user
 * interaction resumes, so re-querying on miss is the correct behavior.)
 *
 * Callers should treat the gate as advisory + defense-in-depth: prefer to
 * skip at the service level (heartbeat, etc.) so no run
 * row / conversation row is created at all, and rely on the gate inside
 * `runBackgroundJob` as the universal backstop.
 */
import { rawGet } from "../persistence/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("pre-first-message-gate");

let cachedHasUserMessage = false;

/**
 * Returns `true` if the local store has ever recorded a user-authored
 * message in a standard conversation.
 *
 * Cheap: indexed lookup with `LIMIT 1`. After the first `true` result the
 * answer is cached in-process and subsequent calls are O(1).
 *
 * On query error the function logs a warning and returns `false` — the
 * conservative interpretation is "we can't prove the user has interacted,
 * so don't fire background work."
 */
export function hasReceivedUserMessage(): boolean {
  if (cachedHasUserMessage) return true;

  try {
    const row = rawGet<{ one: number }>(
      "preFirstMsg:hasReceivedUserMessage",
      `SELECT 1 AS one FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE m.role = 'user'
         AND c.conversation_type = 'standard'
       LIMIT 1`,
    );
    if (row != null) {
      cachedHasUserMessage = true;
      return true;
    }
    return false;
  } catch (err) {
    log.warn(
      { err },
      "hasReceivedUserMessage: query failed; treating as not-yet-received so background work stays paused",
    );
    return false;
  }
}

/**
 * Test-only reset of the in-process cache. Real code paths must never
 * call this — the cache is monotonic by design.
 *
 * @internal
 */
export function _resetPreFirstMessageGateCacheForTests(): void {
  cachedHasUserMessage = false;
}
