import type { DrizzleDb } from "../db-connection.js";

/**
 * Add trigger column to canonical_guardian_requests.
 *
 * Stores what prompted an access request — `denied` (the sender was refused
 * and the guardian decides whether to let them in) or `admitted` (the sender
 * cleared the admission floor unclassified and the guardian is nudged to set
 * their trust level). Resolvers and the expiry sweep read it to suppress
 * requester-facing lifecycle notices for admitted-mode nudges: the sender
 * never asked for access, so "your access request was approved/denied/
 * expired" would misinform them. NULL means `denied` (all pre-existing rows).
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency — no registry
 * entry needed.
 */
export function migrateCanonicalGuardianRequestTrigger(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN request_trigger TEXT`,
    );
  } catch {
    /* already exists */
  }
}
