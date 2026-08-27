import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_refused_credentials";

/**
 * Create `acp_refused_credentials`: which Claude tokens Claude has refused.
 *
 * Its own table rather than a column on `acp_session_history`, because the two
 * answer different questions with different lifetimes. A marker says "show a
 * card for this run" and is fair game for the user to delete along with the
 * run. This says "do not resolve this token again", and clearing session
 * history must not change which credential a spawn selects: a configured
 * `CLAUDE_CODE_OAUTH_TOKEN` lives in config, so forgetting that Claude refused
 * it lets it win over the vault replacement again and reopen the Connect loop.
 *
 * Digests, never tokens. Equality is the only operation, and these records
 * deliberately outlive the runs that produced them.
 *
 * Retained rather than consumed: a revoked value the user never removes from
 * config is resolved by every later spawn too, so a one-shot only spares the
 * first. Keeping them is safe because a value the user actually fixes hashes
 * differently and was never recorded.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateAcpRefusedCredentials(database: DrizzleDb): void {
  getSqliteFrom(database).exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       digest TEXT PRIMARY KEY,
       refused_at INTEGER NOT NULL
     )`,
  );
}
