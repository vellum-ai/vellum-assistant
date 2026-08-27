import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const INDEX = "idx_acp_session_history_auth_marker";

/**
 * Index the credential-failure markers a conversation carries.
 *
 * Every snapshot refetch asks the same question: the newest marked runs in one
 * conversation. The existing indexes cover the parent and the timestamp
 * separately, so that question meant gathering a conversation's rows through
 * one and then sorting them, work that grows with how many runs it has had
 * rather than with the handful the answer needs.
 *
 * Partial, on the marker predicate, so the index holds only rows that carry a
 * failure. Conversations that have never had one contribute nothing to it, and
 * the ordered columns let the scan stop as soon as it has enough.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateAcpAuthMarkerIndex(database: DrizzleDb): void {
  getSqliteFrom(database).exec(
    `CREATE INDEX IF NOT EXISTS ${INDEX}
       ON acp_session_history (parent_conversation_id, started_at DESC)
       WHERE auth_error_code IS NOT NULL`,
  );
}
