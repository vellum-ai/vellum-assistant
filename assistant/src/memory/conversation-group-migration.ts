/**
 * Runtime migration for the conversation_groups table and group_id column
 * on the conversations table. Follows the same lazy-initialization pattern
 * as conversation-display-order-migration.ts.
 *
 * group_id is display/organizational metadata, consistent with how
 * display_order and is_pinned are handled via runtime migration rather
 * than the formal migrations/ pipeline.
 */

import { getLogger } from "../util/logger.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { rawExec, rawGet, rawRun } from "./db.js";

const log = getLogger("conversation-store");

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name:/i.test(err.message);
}

let migrated = false;

/**
 * Uses raw BEGIN/COMMIT for the one-time backfill. Must NOT be called
 * for the first time inside a Drizzle db.transaction() block — SQLite
 * does not support nested transactions. In practice this is safe because
 * the migration is triggered by early startup queries (listConversations,
 * batchSetDisplayOrders) before any transaction-wrapped paths run, and
 * the `migrated` flag makes subsequent calls no-ops.
 */
export function ensureGroupMigration(): void {
  if (migrated) return;

  // 1. Create groups table if not exists
  rawExec(`
    CREATE TABLE IF NOT EXISTS conversation_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_position REAL NOT NULL DEFAULT 0,
      is_system_group BOOLEAN NOT NULL DEFAULT FALSE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);

  // 2. Add group_id column if not exists
  // Match existing error-handling pattern from conversation-display-order-migration.ts:
  // only swallow duplicate-column errors, log+throw everything else.
  try {
    rawRun(
      "ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL",
    );
  } catch (err) {
    if (!isDuplicateColumnError(err)) {
      log.error({ err }, "Failed to add group_id column");
      throw err;
    }
  }

  // 3. Seed system groups.
  const now = Math.floor(Date.now() / 1000);
  rawExec(`
    INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at)
    VALUES
      ('system:pinned', 'Pinned', 0, TRUE, ${now}, ${now}),
      ('system:scheduled', 'Scheduled', 1, TRUE, ${now}, ${now}),
      ('system:background', 'Background', 2, TRUE, ${now}, ${now}),
      ('system:all', 'Recents', 3, TRUE, ${now}, ${now})
  `);

  // One-time migration: move system:all to sortPosition 3 (from 999999).
  // Bump custom groups at position 3+ up by 1 to make room. Wrapped in a
  // transaction so a crash between the shift and the sentinel can't cause
  // repeated drift on restart.
  const sortShiftDone = rawGet<{ id: string }>(
    "SELECT id FROM conversation_groups WHERE id = '_sort_shift_complete'",
  );
  if (!sortShiftDone) {
    try {
      rawExec("BEGIN");
      rawRun(
        "UPDATE conversation_groups SET sort_position = sort_position + 1 WHERE is_system_group = 0 AND sort_position >= 3",
      );
      rawRun(
        "UPDATE conversation_groups SET sort_position = 3 WHERE id = 'system:all' AND sort_position != 3",
      );
      rawRun(
        `INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at)
         VALUES ('_sort_shift_complete', '_sort_shift_complete', -1, TRUE, ${now}, ${now})`,
      );
      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error({ err }, "Sort-position shift transaction failed, rolled back");
      throw err;
    }
  }

  // 4. One-time backfill (guard: persistent marker prevents re-running on restart)
  //
  // The backfill sets group_id on existing conversations based on their attributes.
  // It must only run once — re-running would overwrite user-explicit ungrouping
  // (e.g., user removes a conversation from a group → group_id = NULL → next restart
  // would backfill it back into system:background). A persistent marker row in
  // conversation_groups tracks whether backfill has already completed.
  const backfillDone = rawGet<{ id: string }>(
    "SELECT id FROM conversation_groups WHERE id = '_backfill_complete'",
  );

  if (!backfillDone) {
    ensureDisplayOrderMigration(); // ensure is_pinned column exists first

    // Canonical classification rules (full decision tree with precedence):
    //
    //   1. Pinned:     is_pinned = TRUE
    //                  → system:pinned (always wins, checked first)
    //
    //   2. Scheduled:  source IN ('schedule', 'reminder') OR schedule_job_id IS NOT NULL
    //                  → system:scheduled (checked second)
    //
    //   3. Background: (conversation_type = 'background' AND COALESCE(source, '') != 'notification')
    //                  OR source IN ('heartbeat', 'task')
    //                  AND COALESCE(source, '') NOT IN ('schedule', 'reminder')  ← safety + NULL handling
    //                  AND schedule_job_id IS NULL                               ← safety: prevents overlap with step 2
    //                  → system:background
    //
    //   4. Else:       ungrouped (group_id = NULL)
    //
    // Each backfill step uses AND group_id IS NULL to avoid reassignment.
    // The exclusion guards in step 3 are belt-and-suspenders — step 2's
    // group_id IS NULL guard already prevents overlap, but the explicit
    // exclusions make the SQL self-documenting and migration-order-independent.
    // COALESCE handles NULL source values (legacy rows).

    // Wrap all backfill steps in a transaction so a partial failure
    // (e.g. crash mid-backfill) doesn't leave conversations half-classified
    // with the marker row missing, which would cause a re-run to skip
    // already-classified rows (group_id IS NULL guard).
    try {
      rawExec("BEGIN");

      // Step A: Pinned -> system:pinned (runs first, always wins)
      rawExec(`
        UPDATE conversations SET group_id = 'system:pinned'
        WHERE is_pinned = 1 AND group_id IS NULL
      `);

      // Step B: Scheduled -> system:scheduled (schedule/reminder source or has schedule_job_id)
      rawExec(`
        UPDATE conversations SET group_id = 'system:scheduled'
        WHERE (source IN ('schedule', 'reminder') OR schedule_job_id IS NOT NULL OR conversation_type = 'scheduled')
        AND group_id IS NULL
      `);

      // Step C: Background -> system:background (background type, heartbeat, or task — excluding notifications)
      // Explicit exclusion of schedule sources + schedule_job_id as a safety net.
      // Step B already catches those via group_id IS NULL guard, but the explicit exclusion
      // makes the SQL self-documenting and protects against future migration ordering changes.
      // Note: source can be NULL for legacy rows. NULL != 'notification' evaluates to NULL (not TRUE)
      // in SQL, so use COALESCE to treat NULL source as empty string for the exclusion checks.
      rawExec(`
        UPDATE conversations SET group_id = 'system:background'
        WHERE (
          (conversation_type = 'background' AND COALESCE(source, '') != 'notification')
          OR source IN ('heartbeat', 'task')
        )
        AND COALESCE(source, '') NOT IN ('schedule', 'reminder')
        AND schedule_job_id IS NULL
        AND group_id IS NULL
      `);

      // Mark backfill as complete so it won't re-run on future process restarts
      rawExec(`
        INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group)
        VALUES ('_backfill_complete', '_backfill_complete', -1, TRUE)
      `);

      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error({ err }, "Group backfill transaction failed, rolled back");
      throw err;
    }
  }

  // 5. One-time backfill: assign all ungrouped conversations to system:all
  //
  // Separate from the initial backfill above because system:all is added later.
  // Uses its own sentinel so it runs exactly once, even on existing installations
  // where the original backfill already completed.
  const allBackfillDone = rawGet<{ id: string }>(
    "SELECT id FROM conversation_groups WHERE id = '_backfill_all_complete'",
  );

  if (!allBackfillDone) {
    try {
      rawExec("BEGIN");

      rawExec(`
        UPDATE conversations SET group_id = 'system:all' WHERE group_id IS NULL
      `);

      rawExec(`
        INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group)
        VALUES ('_backfill_all_complete', '_backfill_all_complete', -1, TRUE)
      `);

      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error({ err }, "system:all backfill transaction failed, rolled back");
      throw err;
    }
  }

  // 6. One-time migration: move auto-analysis conversations from system:reflections to system:background
  const reflectionsMigrateDone = rawGet<{ id: string }>(
    "SELECT id FROM conversation_groups WHERE id = '_reflections_to_background_complete'",
  );

  if (!reflectionsMigrateDone) {
    try {
      rawExec("BEGIN");

      rawExec(`
        UPDATE conversations SET group_id = 'system:background'
        WHERE group_id = 'system:reflections'
      `);

      rawExec(`
        INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group)
        VALUES ('_reflections_to_background_complete', '_reflections_to_background_complete', -1, TRUE)
      `);

      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error({ err }, "reflections-to-background migration failed, rolled back");
      throw err;
    }
  }

  // 7. One-time cleanup: delete the orphaned system:reflections group row.
  //
  // Reflections render as a sub-group under Background via the client's
  // sub-group label provider; the standalone system:reflections group is no
  // longer referenced by any conversation after step 6. Leaving the row in
  // place causes the macOS sidebar to render an empty duplicate "Reflections"
  // entry with a fallback folder icon alongside the Background sub-group.
  const reflectionsGroupDeleted = rawGet<{ id: string }>(
    "SELECT id FROM conversation_groups WHERE id = '_reflections_group_deleted_complete'",
  );

  if (!reflectionsGroupDeleted) {
    try {
      rawExec("BEGIN");

      // Belt-and-suspenders: re-run the conversation move in case a straggler
      // crept in between step 6's sentinel being set and this step shipping.
      rawExec(`
        UPDATE conversations SET group_id = 'system:background'
        WHERE group_id = 'system:reflections'
      `);

      rawExec(`DELETE FROM conversation_groups WHERE id = 'system:reflections'`);

      rawExec(`
        INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group)
        VALUES ('_reflections_group_deleted_complete', '_reflections_group_deleted_complete', -1, TRUE)
      `);

      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error({ err }, "reflections-group deletion failed, rolled back");
      throw err;
    }
  }

  migrated = true;
}
