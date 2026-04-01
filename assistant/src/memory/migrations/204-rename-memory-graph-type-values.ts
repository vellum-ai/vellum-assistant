import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * One-shot migration: rename legacy memory graph node type values.
 *
 * The PR that introduced the memory graph used "style" and "relationship"
 * as type values.  These were renamed to "behavioral" and "semantic" in
 * code, but existing rows in the database still carry the old values.
 */
export function migrateRenameMemoryGraphTypeValues(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_rename_memory_graph_type_values_v1",
    () => {
      const raw = getSqliteFrom(database);
      raw
        .prepare(
          /*sql*/ `UPDATE memory_graph_nodes SET type = 'behavioral' WHERE type = 'style'`,
        )
        .run();
      raw
        .prepare(
          /*sql*/ `UPDATE memory_graph_nodes SET type = 'semantic' WHERE type = 'relationship'`,
        )
        .run();
    },
  );
}

/**
 * Reverse: restore the original type values.
 */
export function migrateRenameMemoryGraphTypeValuesDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw
    .prepare(
      /*sql*/ `UPDATE memory_graph_nodes SET type = 'style' WHERE type = 'behavioral'`,
    )
    .run();
  raw
    .prepare(
      /*sql*/ `UPDATE memory_graph_nodes SET type = 'relationship' WHERE type = 'semantic'`,
    )
    .run();
}
