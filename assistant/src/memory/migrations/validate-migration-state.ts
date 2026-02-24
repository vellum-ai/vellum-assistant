import { getSqliteFrom, type DrizzleDb } from '../db-connection.js';
import { getLogger } from '../../util/logger.js';
import { MIGRATION_REGISTRY, type MigrationValidationResult } from './registry.js';

const log = getLogger('memory-db');

/**
 * Validate the applied migration state against the registry at startup.
 *
 * Logs warnings when a migration started but never completed (crash detected),
 * and logs errors when a migration was applied but a declared prerequisite is
 * missing from the checkpoints table (dependency ordering violation).
 *
 * Returns structured diagnostic data so callers (e.g. tests) can assert on the
 * specific issues detected without having to re-query the DB or inspect logs.
 *
 * Call this AFTER all DDL and migration functions have run so that the final
 * state is inspected.
 */
export function validateMigrationState(database: DrizzleDb): MigrationValidationResult {
  const raw = getSqliteFrom(database);

  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw.query(`SELECT key, value FROM memory_checkpoints`).all() as Array<{ key: string; value: string }>;
  } catch {
    // memory_checkpoints may not exist on a very old database; skip.
    return { crashed: [], dependencyViolations: [] };
  }

  // Detect crashed migrations: a checkpoint value of 'started' means the
  // migration wrote its start marker but never reached the completion INSERT.
  // The migration will re-run on the next startup (its own idempotency guard
  // will determine safety), but we surface a warning for visibility.
  const crashed = rows.filter((r) => r.value === 'started').map((r) => r.key);
  if (crashed.length > 0) {
    log.warn(
      { crashed },
      'Crashed migrations detected — these migrations started but never completed; they will re-run on next startup',
    );
  }

  // Only rows whose value is NOT 'started' represent truly completed migrations.
  // In-progress/crashed checkpoints (value = 'started') must not count as applied
  // dependencies — the migration never finished, so its postconditions are unmet.
  const completed = new Set(rows.filter((r) => r.value !== 'started').map((r) => r.key));

  const dependencyViolations: Array<{ migration: string; missingDependency: string }> = [];

  // Validate dependency ordering.
  for (const entry of MIGRATION_REGISTRY) {
    if (!entry.dependsOn || entry.dependsOn.length === 0) continue;
    // Only check entries that have been completed — unapplied or in-progress
    // migrations have not had a chance to violate their prerequisites yet.
    if (!completed.has(entry.key)) continue;

    for (const dep of entry.dependsOn) {
      if (!completed.has(dep)) {
        log.error(
          { migration: entry.key, missingDependency: dep, version: entry.version },
          'Migration dependency violation: this migration is marked complete but its declared prerequisite has no checkpoint — database schema may be inconsistent',
        );
        dependencyViolations.push({ migration: entry.key, missingDependency: dep });
      }
    }
  }

  return { crashed, dependencyViolations };
}
