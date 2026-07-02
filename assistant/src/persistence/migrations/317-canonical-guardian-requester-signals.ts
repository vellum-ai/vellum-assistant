import type { DrizzleDb } from "../db-connection.js";

/**
 * Add requester_signals column to canonical_guardian_requests.
 *
 * Stores the JSON-encoded platform identity signals for the requester
 * (isBot / isStranger / isRestricted) at request-creation time, so the
 * introduction-card decision path derives binding strength and bot handling
 * from the same facts the card was rendered from.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency — no registry
 * entry needed.
 */
export function migrateCanonicalGuardianRequesterSignals(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN requester_signals TEXT`,
    );
  } catch {
    /* already exists */
  }
}
