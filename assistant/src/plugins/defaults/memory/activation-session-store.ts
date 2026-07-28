import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("activation-session-store");

/**
 * Mark a conversation as an activation-rail session. Idempotent (the row's
 * primary key is the conversation id) and best-effort: an unavailable memory
 * database or a write failure is logged and swallowed so it never blocks the
 * turn that triggered it.
 */
export function markActivationSession(conversationId: string): void {
  try {
    const raw = memorySqliteOrNull("markActivationSession");
    if (!raw) {
      return;
    }
    raw
      .query(
        /*sql*/ `INSERT OR IGNORE INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)`,
      )
      .run(conversationId, Date.now());
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to mark activation session");
  }
}

/**
 * Whether the given conversation was started on the activation rail.
 * Best-effort: an unavailable memory database or a read failure is logged and
 * treated as "not an activation session".
 */
export function isActivationSession(conversationId: string): boolean {
  try {
    const raw = memorySqliteOrNull("isActivationSession");
    if (!raw) {
      return false;
    }
    return (
      raw
        .query(
          /*sql*/ `SELECT 1 FROM activation_sessions WHERE conversation_id = ?`,
        )
        .get(conversationId) != null
    );
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to read activation session");
    return false;
  }
}
