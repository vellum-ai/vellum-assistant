import { IntegrityError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';
import { type DrizzleDb,getSqliteFrom } from '../db-connection.js';
import { MIGRATION_REGISTRY, type MigrationValidationResult } from './registry.js';

const log = getLogger('memory-db');

/**
 * Validate the applied migration state against the registry at startup.
 *
 * Logs a prominent error when a migration started but never completed (crash
 * detected) — startup continues so the migration can be retried.
 *
 * Throws an IntegrityError when a migration was applied but a declared
 * prerequisite is missing from the checkpoints table (dependency ordering
 * violation). This blocks daemon startup to prevent running with an
 * inconsistent database schema.
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
    log.error(
      { crashed },
      [
        '╔══════════════════════════════════════════════════════════════╗',
        '║  CRASHED MIGRATIONS DETECTED                               ║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
        `The following migrations started but never completed: ${crashed.join(', ')}`,
        '',
        'These will be retried automatically on this startup.',
        'If retries continue to fail, manually update the checkpoint:',
        '  sqlite3 ~/.vellum/data/assistant.db "DELETE FROM memory_checkpoints WHERE key = \'<migration_key>\'"',
        'Then restart the daemon.',
      ].join('\n'),
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
        dependencyViolations.push({ migration: entry.key, missingDependency: dep });
      }
    }
  }

  if (dependencyViolations.length > 0) {
    const details = dependencyViolations
      .map((v) => `  - "${v.migration}" requires "${v.missingDependency}" but it has no checkpoint`)
      .join('\n');
    throw new IntegrityError(
      `Migration dependency violations detected — database schema may be inconsistent:\n${details}\n` +
      'The daemon cannot start safely. Inspect the database and re-run missing migrations.',
    );
  }

  return { crashed, dependencyViolations };
}
