import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Adds blocked-step metadata for confirmed task plans.
 *
 * The status value itself is stored in the existing `status` text column; this
 * nullable reason gives the assistant a concise explanation to carry across
 * turns when a plan cannot advance.
 */
export function migratePlanStepBlockedReason(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec(`
      ALTER TABLE plan_steps
      ADD COLUMN blocked_reason TEXT
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("duplicate column name")) {
      throw err;
    }
  }
}
