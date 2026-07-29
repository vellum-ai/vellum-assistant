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
 * Tables and columns with credential-like names (token, api_key, password,
 * secret, session, and similar) are excluded from extraction entirely so
 * that live credentials never reach stdout or downstream memory; the
 * exclusions are reported in the stderr census. Rows are read in batches
 * over only the candidate columns, so a large database is never
 * materialized in memory at once. A per-table census is printed to stderr
 * so the review step can see what was extracted and what was skipped.
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

/** Rows fetched per batch so large tables never materialize fully. */
const ROW_BATCH_SIZE = 1000;

/**
 * Name segments that mark a table or column as credential-bearing.
 * Matching is word-boundary aware: names are split into segments on
 * underscores, other separators, and camelCase boundaries, so "auth"
 * matches "auth_state" and "userAuth" but not "author".
 */
const SECRET_NAME_SEGMENTS = new Set([
  "token",
  "apikey",
  "password",
  "passwd",
  "pwd",
  "secret",
  "credential",
  "cred",
  "cookie",
  "session",
  "auth",
  "bearer",
  "oauth",
  "refresh",
  "privatekey",
  "jwt",
]);

/** Adjacent segment pairs that together indicate a credential name. */
const SECRET_SEGMENT_PAIRS = new Set([
  "api key",
  "private key",
  "access key",
  "signing key",
  "encryption key",
]);

/**
 * Split a table or column name into lowercase word segments, with a
 * trailing plural "s" stripped so "tokens" and "api_keys" match the
 * singular patterns.
 */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/s$/, ""));
}

/** True when a table or column name looks like it holds credentials. */
export function isSecretName(name: string): boolean {
  const segments = nameSegments(name);
  for (const segment of segments) {
    if (SECRET_NAME_SEGMENTS.has(segment)) {
      return true;
    }
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (SECRET_SEGMENT_PAIRS.has(`${segments[i]} ${segments[i + 1]}`)) {
      return true;
    }
  }
  return false;
}

export interface TableCensus {
  table: string;
  status: "extracted" | "skipped";
  reason?: string;
  rows?: number;
  items?: number;
  /** Columns excluded from extraction because their names look credential-bearing. */
  secretColumns?: string[];
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
      if (isSecretName(table.name)) {
        census.push({
          table: table.name,
          status: "skipped",
          reason: "credential-like table name (excluded from extraction)",
        });
        continue;
      }

      const columns = (
        db.query("SELECT name FROM pragma_table_info(?)").all(table.name) as {
          name: string;
        }[]
      ).map((c) => c.name);
      const secretColumns = columns.filter((name) => isSecretName(name));
      const safeColumns = columns.filter((name) => !isSecretName(name));
      const timestampColumns = safeColumns.filter((name) =>
        TIMESTAMP_COLUMN.test(name),
      );
      const textCandidateColumns = safeColumns.filter(
        (name) => !TIMESTAMP_COLUMN.test(name) && !IDENTIFIER_COLUMN.test(name),
      );

      const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const quoted = quoteIdent(table.name);
      const selectColumns = [...textCandidateColumns, ...timestampColumns];

      let rowCount = 0;
      let extracted = 0;
      if (selectColumns.length === 0) {
        rowCount = (
          db.query(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as {
            n: number;
          }
        ).n;
      } else {
        // Narrow the SELECT to candidate columns and read in batches so
        // blobs and large tables never materialize fully in memory.
        const batchQuery = db.query(
          `SELECT ${selectColumns.map(quoteIdent).join(", ")} FROM ${quoted} LIMIT ${ROW_BATCH_SIZE} OFFSET ?`,
        );
        for (let offset = 0; ; offset += ROW_BATCH_SIZE) {
          const rows = batchQuery.all(offset) as Record<string, unknown>[];
          rowCount += rows.length;

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

          if (rows.length < ROW_BATCH_SIZE) {
            break;
          }
        }
      }

      const entry: TableCensus = {
        table: table.name,
        status: "extracted",
        rows: rowCount,
        items: extracted,
      };
      if (secretColumns.length > 0) {
        entry.secretColumns = secretColumns;
      }
      census.push(entry);
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
      if (entry.secretColumns && entry.secretColumns.length > 0) {
        process.stderr.write(
          `    skipped credential-like columns: ${entry.secretColumns.join(", ")}\n`,
        );
      }
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
