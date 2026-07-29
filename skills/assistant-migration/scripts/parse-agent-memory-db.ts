#!/usr/bin/env bun

/**
 * Dump memory-import candidates from a Hermes or OpenClaw `memory.db`
 * SQLite snapshot as `MemoryImportItem[]` JSON on stdout.
 *
 * This produces *review candidates*, not final memories. Hermes and
 * OpenClaw schemas are not standardized across versions, so instead of
 * assuming table names or columns, the script introspects `sqlite_master`
 * and dumps the text-bearing columns of every user table. The creator
 * reviews the candidate inventory before anything is saved to memory.
 *
 * FTS5 virtual tables and their shadow tables are skipped: they are
 * rebuildable search indexes, not source data (see references/hermes.md).
 * A per-table census is printed to stderr so the review step can see what
 * was extracted and what was skipped.
 *
 * The database is opened read-only. Point `--file` at a consistent
 * snapshot (`sqlite3 memory.db ".backup snapshot.db"`), never a live DB.
 *
 * Usage:
 *   bun run scripts/parse-agent-memory-db.ts --file /path/to/memory.db --source hermes
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import {
  printItemsJson,
  toIsoDate,
  type MemoryImportItem,
} from "./lib/memory-items.js";

const SUPPORTED_SOURCES = ["hermes", "openclaw"] as const;
type SourceProvider = (typeof SUPPORTED_SOURCES)[number];

/** Column names that look like timestamps (feed origin_date, not text). */
const TIMESTAMP_COLUMN = /(date|time|created|updated|modified|_at$|_ts$)/i;

/** Column names that look like opaque identifiers, not memory text. */
const IDENTIFIER_COLUMN = /(^|_)(id|uuid|guid|key|hash|checksum)$/i;

/** FTS5 shadow tables share the virtual table's name plus these suffixes. */
const FTS5_SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config"];

export interface TableCensus {
  table: string;
  status: "extracted" | "skipped";
  reason?: string;
  rows?: number;
  items?: number;
}

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

export function extractMemoryDb(
  dbPath: string,
  provider: SourceProvider,
): { items: MemoryImportItem[]; census: TableCensus[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as SqliteMasterRow[];

    const ftsTables = new Set(
      tables
        .filter((t) => /USING\s+fts5\s*\(/i.test(t.sql ?? ""))
        .map((t) => t.name),
    );
    const ftsShadowTables = new Set(
      [...ftsTables].flatMap((name) =>
        FTS5_SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`),
      ),
    );

    const items: MemoryImportItem[] = [];
    const census: TableCensus[] = [];

    for (const table of tables) {
      if (table.name.startsWith("sqlite_")) {
        census.push({
          table: table.name,
          status: "skipped",
          reason: "sqlite internal table",
        });
        continue;
      }
      if (ftsTables.has(table.name)) {
        census.push({
          table: table.name,
          status: "skipped",
          reason: "fts5 virtual table (rebuildable index)",
        });
        continue;
      }
      if (ftsShadowTables.has(table.name)) {
        census.push({
          table: table.name,
          status: "skipped",
          reason: "fts5 shadow table (rebuildable index)",
        });
        continue;
      }

      const columns = (
        db.query("SELECT name FROM pragma_table_info(?)").all(table.name) as {
          name: string;
        }[]
      ).map((c) => c.name);
      const timestampColumns = columns.filter((name) =>
        TIMESTAMP_COLUMN.test(name),
      );
      const textCandidateColumns = columns.filter(
        (name) => !TIMESTAMP_COLUMN.test(name) && !IDENTIFIER_COLUMN.test(name),
      );

      const quoted = `"${table.name.replaceAll('"', '""')}"`;
      const rows = db.query(`SELECT * FROM ${quoted}`).all() as Record<
        string,
        unknown
      >[];

      let extracted = 0;
      for (const row of rows) {
        let originDate: string | undefined;
        for (const column of timestampColumns) {
          originDate = toIsoDate(row[column]);
          if (originDate) {
            break;
          }
        }

        for (const column of textCandidateColumns) {
          const value = row[column];
          if (typeof value !== "string") {
            continue;
          }
          const text = value.trim();
          if (text.length === 0 || toIsoDate(text) !== undefined) {
            continue;
          }
          const item: MemoryImportItem = {
            text,
            source: `import:${provider}`,
            context: `${table.name}.${column}`,
          };
          if (originDate) {
            item.origin_date = originDate;
          }
          items.push(item);
          extracted++;
        }
      }

      census.push({
        table: table.name,
        status: "extracted",
        rows: rows.length,
        items: extracted,
      });
    }

    return { items, census };
  } finally {
    db.close();
  }
}

function parseCliArgs(): { filePath: string; source: SourceProvider } {
  const args = process.argv.slice(2);
  let filePath: string | null = null;
  let source: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === "--source" && i + 1 < args.length) {
      source = args[i + 1];
      i++;
    }
  }

  if (!filePath || !source) {
    process.stderr.write(
      "Usage: bun run scripts/parse-agent-memory-db.ts --file <memory.db snapshot> --source <hermes|openclaw>\n",
    );
    process.exit(1);
  }
  if (!(SUPPORTED_SOURCES as readonly string[]).includes(source)) {
    process.stderr.write(
      `Error: unsupported --source "${source}" (expected: ${SUPPORTED_SOURCES.join(", ")})\n`,
    );
    process.exit(1);
  }

  return { filePath, source: source as SourceProvider };
}

function main() {
  const { filePath, source } = parseCliArgs();

  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  let result: ReturnType<typeof extractMemoryDb>;
  try {
    result = extractMemoryDb(filePath, source);
  } catch (err) {
    process.stderr.write(
      `Error reading database: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  process.stderr.write("Table census:\n");
  for (const entry of result.census) {
    if (entry.status === "extracted") {
      process.stderr.write(
        `  extracted: ${entry.table} (${entry.rows} rows, ${entry.items} candidate items)\n`,
      );
    } else {
      process.stderr.write(`  skipped: ${entry.table} (${entry.reason})\n`);
    }
  }
  process.stderr.write(
    `Total: ${result.items.length} review candidates. These are candidates for creator review, not final memories.\n`,
  );

  printItemsJson(result.items);
}

if (import.meta.main) {
  main();
}
