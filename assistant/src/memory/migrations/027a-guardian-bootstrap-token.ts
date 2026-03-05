import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add bootstrap_token_hash column to channel_guardian_verification_challenges.
 * Used by the Telegram outbound verification bootstrap deep-link flow:
 * a random token is hashed and stored so the /start gv_<token> command
 * can look up the pending_bootstrap session without exposing the code.
 */
export function migrateGuardianBootstrapToken(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN bootstrap_token_hash TEXT`,
    );
  } catch {
    /* already exists */
  }

  // Index for looking up pending_bootstrap sessions by bootstrap token hash
  if (
    tableHasColumn(
      database,
      "channel_guardian_verification_challenges",
      "assistant_id",
    )
  ) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_bootstrap ON channel_guardian_verification_challenges(assistant_id, channel, bootstrap_token_hash, status)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_bootstrap ON channel_guardian_verification_challenges(channel, bootstrap_token_hash, status)`,
    );
  }
}
