/**
 * Compare the Drizzle table/column catalog in source to a live SQLite schema.
 *
 * Used by `assistant db status` to surface a binary that selects a
 * column the live database never received. Extra SQLite tables or
 * columns are ignored. Those are often raw-SQL fields (`group_id`) that
 * Drizzle does not own.
 *
 * The catalog is the union of every `sqliteTable` exported from
 * `schema/index.ts`. Tables live across the main, logs, memory, and
 * telemetry files; callers merge those files before calling
 * {@link diffDrizzleSchemaContract}.
 */

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";

import * as schema from "./schema/index.js";

export interface SchemaColumnMiss {
  table: string;
  column: string;
}

export interface SchemaContractReport {
  /** Drizzle tables with no matching SQLite table in the live files. */
  missingTables: string[];
  /** Drizzle columns whose table exists in SQLite but the column does not. */
  missingColumns: SchemaColumnMiss[];
}

export interface DrizzleTableColumns {
  name: string;
  columns: string[];
}

/** Every Drizzle table name and its SQL column names, de-duplicated. */
export function listDrizzleTables(): DrizzleTableColumns[] {
  const byName = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, Table)) {
      continue;
    }
    const name = getTableName(value);
    if (!name) {
      continue;
    }
    const columns = Object.values(getTableColumns(value)).map(
      (column) => column.name,
    );
    byName.set(name, columns);
  }
  return [...byName.entries()]
    .map(([name, columns]) => ({ name, columns: [...columns].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Diff Drizzle's catalog against a merged live schema (table name → columns).
 * Tables and columns present only in SQLite are not reported.
 */
export function diffDrizzleSchemaContract(
  liveColumnsByTable: Map<string, ReadonlySet<string>>,
): SchemaContractReport {
  const missingTables: string[] = [];
  const missingColumns: SchemaColumnMiss[] = [];

  for (const table of listDrizzleTables()) {
    const live = liveColumnsByTable.get(table.name);
    if (!live) {
      missingTables.push(table.name);
      continue;
    }
    for (const column of table.columns) {
      if (!live.has(column)) {
        missingColumns.push({ table: table.name, column });
      }
    }
  }

  missingTables.sort();
  missingColumns.sort((a, b) => {
    const tableCmp = a.table.localeCompare(b.table);
    if (tableCmp !== 0) {
      return tableCmp;
    }
    return a.column.localeCompare(b.column);
  });

  return { missingTables, missingColumns };
}

export function schemaContractIsClean(report: SchemaContractReport): boolean {
  return (
    report.missingTables.length === 0 && report.missingColumns.length === 0
  );
}
