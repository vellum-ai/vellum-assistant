import { rawRun } from "../db.js";

export function migrateDropConflicts(): void {
  rawRun(`DROP TABLE IF EXISTS memory_item_conflicts`);
}
