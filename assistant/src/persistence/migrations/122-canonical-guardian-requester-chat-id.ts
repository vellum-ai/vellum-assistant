import type { DrizzleDb } from "../db-connection.js";

/**
 * Add requester_chat_id column to canonical_guardian_requests.
 *
 * On channels like Slack, the external chat ID (channel/DM ID) differs from
 * the sender's external user ID. Without this column the access_request
 * resolver would deliver approval/denial messages to the wrong destination.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency — no registry
 * entry needed.
 */
export function migrateCanonicalGuardianRequesterChatId(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN requester_chat_id TEXT`,
    );
  } catch {
    /* already exists */
  }
}
