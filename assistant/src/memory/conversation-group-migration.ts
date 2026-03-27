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
import { rawExec, rawRun } from "./db.js";

const log = getLogger("conversation-store");

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name:/i.test(err.message);
}

let migrated = false;

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

  // 3. Seed system groups (three: pinned, scheduled, background)
  rawExec(`
    INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group)
    VALUES
      ('system:pinned', 'Pinned', 0, TRUE),
      ('system:scheduled', 'Scheduled', 1, TRUE),
      ('system:background', 'Background', 2, TRUE)
  `);

  // 4. One-time backfill (guard: only if not already done)
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

  // Step A: Pinned -> system:pinned (runs first, always wins)
  rawExec(`
    UPDATE conversations SET group_id = 'system:pinned'
    WHERE is_pinned = 1 AND group_id IS NULL
  `);

  // Step B: Scheduled -> system:scheduled (schedule/reminder source or has schedule_job_id)
  rawExec(`
    UPDATE conversations SET group_id = 'system:scheduled'
    WHERE (source IN ('schedule', 'reminder') OR schedule_job_id IS NOT NULL)
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

  migrated = true;
}
