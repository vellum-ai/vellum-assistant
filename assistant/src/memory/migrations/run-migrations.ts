import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";

const log = getLogger("db-init");

/** A single forward migration step, identified for logging by its `.name`. */
export type MigrationStep = (database: DrizzleDb) => void;

export interface MigrationRunResult {
  /** Steps whose body threw. */
  failed: string[];
}

/**
 * Run the ordered list of forward migration steps against the database.
 *
 * Individual step failures are caught and logged so one broken migration does
 * not prevent independent later ones from succeeding.
 */
export function runMigrationSteps(
  database: DrizzleDb,
  steps: MigrationStep[],
): MigrationRunResult {
  const failed: string[] = [];

  for (const step of steps) {
    try {
      log.debug({ migration: step.name }, `Starting migration: ${step.name}`);
      step(database);
      log.debug({ migration: step.name }, `Migration succeeded: ${step.name}`);
    } catch (err) {
      failed.push(step.name);
      log.error(
        { err, migration: step.name },
        `Migration failed: ${step.name}`,
      );
    }
  }

  return { failed };
}
