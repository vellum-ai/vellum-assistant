import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-352");

/**
 * Drops the script-handoff and skill-binding columns from `cron_jobs`.
 *
 * Migration 351 added `then_execute`, `skill_id`, and `skill_version_hash` for
 * a feature that has since been reverted. 351 is deliberately left in place:
 * it has already run on deployed assistants, and removing a migration the
 * ledger has recorded would break migration-state validation. So the pair
 * nets to nothing — 351 adds the columns, this drops them again.
 *
 * No data is carried over. The feature never shipped to users, so no schedule
 * has meaningful values in these columns.
 *
 * Idempotent: each column is checked before it is dropped, so re-running after
 * a partial application is a no-op.
 */
export function migrateDropScheduleSkillScriptHandoff(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  for (const column of ["then_execute", "skill_id", "skill_version_hash"]) {
    if (!columnNames.has(column)) {
      continue;
    }
    raw.exec(`ALTER TABLE cron_jobs DROP COLUMN ${column}`);
    log.info({ column }, "Dropped reverted schedule column from cron_jobs");
  }
}
