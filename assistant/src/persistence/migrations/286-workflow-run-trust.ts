import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add a `trust_json` column to `workflow_runs`.
 *
 * Persists the originating {@link TrustContext} (trust metadata — NOT secret
 * material) so a crash-orphaned run can reconstruct the exact trust class it
 * started under when it is resumed after a restart. Without this, resume could
 * only fall back to a default, and the previous fallback was the internal
 * guardian context — a privilege escalation, since a run started by a low-trust
 * actor would resume with the side-effect approval gate cleared.
 *
 * Nullable — legacy rows written before this column stay NULL and resume at the
 * low-trust fallback (never guardian).
 *
 * Idempotent — the ALTER is wrapped so a re-run (column already present) is a
 * no-op.
 */
export function migrateWorkflowRunTrust(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE workflow_runs ADD COLUMN trust_json TEXT`);
  } catch {
    /* Column already exists */
  }
}
