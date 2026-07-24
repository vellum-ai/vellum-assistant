import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * The web empty-state greeting posts to `/v1/btw` with `conversationKey`
 * "greeting". That side-chain is ephemeral and persists nothing, so its id is
 * a literal string rather than a minted uuid.
 */
const STRAY_GREETING_CONVERSATION_ID = "greeting";

/**
 * Delete the stray `greeting` conversations row when it carries no messages.
 *
 * A message-less row with this id is an artifact of the ephemeral empty-state
 * greeting side-chain and renders as an "Untitled" conversation in every
 * client's sidebar. A row carrying messages means the user opened it and
 * chatted, so it is user data and is left untouched.
 *
 * The ephemeral greeting path persists no messages, tool invocations, request
 * logs, or telemetry, so the conversations row is the only artifact to remove.
 * `tool_invocations` is cleared defensively — it is the sole conversation-
 * scoped table a message-less conversation delete touches on the main
 * database, and clearing it keeps the migration self-contained if some other
 * path ever attached one.
 *
 * Idempotent: once the row is gone (or when the user has chatted in it) a
 * re-run matches nothing and no-ops.
 */
export function migrateDeleteStrayGreetingConversation(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const hasMessages = raw
    .query(/*sql*/ `SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1`)
    .get(STRAY_GREETING_CONVERSATION_ID);
  if (hasMessages) {
    return;
  }

  raw
    .query(/*sql*/ `DELETE FROM tool_invocations WHERE conversation_id = ?`)
    .run(STRAY_GREETING_CONVERSATION_ID);
  raw
    .query(/*sql*/ `DELETE FROM conversations WHERE id = ?`)
    .run(STRAY_GREETING_CONVERSATION_ID);
}
