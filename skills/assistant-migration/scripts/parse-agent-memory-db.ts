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
 * exclusions are reported in the stderr census. Text values that survive
 * the name filters are additionally run through a value-level secret
 * scanner: well-known token shapes and credential-like key=value
 * assignments are redacted in place (replaced with `[redacted:<kind>]`)
 * before emission, with per-table redaction counts reported in the
 * stderr census. Rows are read in batches
 * over only the candidate columns, and candidates are streamed to stdout
 * as they are found, so neither the database rows nor the emitted JSON
 * array is ever materialized in memory at once. A per-table census is
 * printed to stderr so the review step can see what was extracted and
 * what was skipped.
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
  createItemsJsonStreamWriter,
  toIsoDate,
  type MemoryImportItem,
} from "./lib/memory-items.js";

const SUPPORTED_SOURCES = ["hermes", "openclaw"] as const;
type SourceProvider = (typeof SUPPORTED_SOURCES)[number];

/**
 * Name segments that mark a column as a timestamp (feeds origin_date, not
 * text). Matched against whole segments, not substrings: "candidate" and
 * "timezone" contain "date"/"time" but are not timestamp columns, and a
 * substring match would silently drop their text from extraction.
 */
const TIMESTAMP_NAME_SEGMENTS = new Set([
  "date",
  "datetime",
  "time",
  "timestamp",
  "t",
  "created",
  "updated",
  "modified",
  "at",
  "ts",
]);

/** True when a column name's segments mark it as a timestamp column. */
export function isTimestampColumnName(name: string): boolean {
  const segments = nameSegments(name);
  // A lone "at"/"ts" segment only counts as part of a compound name
  // ("created_at", "event_ts"); a single-segment name must itself be a
  // timestamp word ("date", "timestamp").
  if (segments.length === 1) {
    return (
      TIMESTAMP_NAME_SEGMENTS.has(segments[0]) &&
      !["at", "ts"].includes(segments[0])
    );
  }
  return segments.some((segment) => TIMESTAMP_NAME_SEGMENTS.has(segment));
}

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
 * singular patterns. Segments ending in "ss" (access, pass) are not
 * depluralized: stripping their final "s" would break pair matches
 * like "access key".
 */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.endsWith("ss") ? segment : segment.replace(/s$/, ""),
    );
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

/**
 * Value-level secret scanner for text that already passed the name-based
 * filters. Credentials can hide in generic text columns (a memory that
 * says "my key is sk-..." or a JSON settings blob), so each candidate is
 * scanned for well-known token shapes and credential-like assignments,
 * and matches are redacted in place.
 *
 * Deliberately conservative: only well-known token shapes (recognizable
 * by prefix/structure) and key=value assignments with a credential-like
 * key are redacted. There is intentionally NO generic high-entropy
 * detector: on real memory prose it produces false positives (mangling
 * ordinary text the user wanted to keep) that are worse than relying on
 * the creator-review step to catch exotic secret shapes.
 */
const SECRET_VALUE_PATTERNS: { kind: string; regex: RegExp }[] = [
  {
    kind: "private-key",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    kind: "openai-key",
    regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    kind: "github-token",
    regex:
      /(?<![A-Za-z0-9_-])(?:github_pat_[A-Za-z0-9_]{20,}|gh[opsur]_[A-Za-z0-9]{20,})/g,
  },
  {
    kind: "aws-access-key-id",
    regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  },
  {
    kind: "slack-token",
    regex: /(?<![A-Za-z0-9])xox[abpsr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    kind: "google-api-key",
    regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}/g,
  },
  {
    kind: "jwt",
    regex:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "bearer-token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?![A-Za-z0-9._~+/=-])/g,
  },
];

/**
 * `key=value` (or `key: value`) assignments where the key is
 * credential-like (checked against the same name blocklist as tables and
 * columns via `isSecretName`) and the value is token-like: at least 16
 * characters with no spaces or quotes. Short or space-containing values
 * are left alone so ordinary prose ("the token: is stored safely") is
 * never mangled.
 */
const SECRET_ASSIGNMENT_REGEX =
  /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]{0,63})(\s*[=:]\s*)(["']?)([^\s"'[\]]{16,})/g;

/**
 * Redact secret-shaped spans in `text`, replacing each match with
 * `[redacted:<kind>]`. Returns the redacted text and the number of
 * redacted spans. Assignments are scanned first so a shaped token used
 * as an assignment value is counted once, and redaction placeholders
 * contain no token-like characters, so passes never rematch each other's
 * output.
 */
export function redactSecretValues(text: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  let out = text;

  // PEM blocks first: they span lines and must be removed whole before
  // any line-oriented pattern can match inside them.
  const [pemPattern, ...shapePatterns] = SECRET_VALUE_PATTERNS;
  out = out.replace(pemPattern.regex, () => {
    redactions++;
    return `[redacted:${pemPattern.kind}]`;
  });

  // Manual exec loop instead of String.replace: when a candidate key is
  // not credential-like ("recipe: password=..."), scanning must resume
  // just after the rejected key so the inner assignment is still caught.
  const assignment = new RegExp(SECRET_ASSIGNMENT_REGEX.source, "g");
  let assembled = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(out)) !== null) {
    const [full, key, sep, quote] = match;
    if (!isSecretName(key)) {
      assignment.lastIndex = match.index + key.length;
      continue;
    }
    assembled +=
      out.slice(last, match.index) +
      `${key}${sep}${quote}[redacted:credential-assignment]`;
    last = match.index + full.length;
    redactions++;
  }
  out = assembled + out.slice(last);

  for (const { kind, regex } of shapePatterns) {
    out = out.replace(regex, () => {
      redactions++;
      return `[redacted:${kind}]`;
    });
  }

  return { text: out, redactions };
}

export interface TableCensus {
  table: string;
  status: "extracted" | "skipped";
  reason?: string;
  rows?: number;
  items?: number;
  /** Columns excluded from extraction because their names look credential-bearing. */
  secretColumns?: string[];
  /** Secret-shaped spans redacted in place from this table's emitted text. */
  redactions?: number;
}

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

/**
 * Walk every extractable table and hand each candidate to `onItem` as it
 * is found. Candidates are never accumulated here: the CLI streams them
 * straight to stdout, and tests collect them in the callback.
 */
export function extractMemoryDb(
  dbPath: string,
  provider: SourceProvider,
  onItem: (item: MemoryImportItem) => void,
): { census: TableCensus[]; totalItems: number } {
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

    const census: TableCensus[] = [];
    let totalItems = 0;

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
        isTimestampColumnName(name),
      );
      const textCandidateColumns = safeColumns.filter(
        (name) => !isTimestampColumnName(name) && !IDENTIFIER_COLUMN.test(name),
      );

      const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const quoted = quoteIdent(table.name);
      const selectColumns = [...textCandidateColumns, ...timestampColumns];

      let rowCount = 0;
      let extracted = 0;
      let redacted = 0;
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
              const rawText = value.trim();
              if (rawText.length === 0 || toIsoDate(rawText) !== undefined) {
                continue;
              }
              // Name filters cannot catch credentials stored inside
              // generic text columns, so redact secret-shaped spans from
              // the value itself before it reaches stdout.
              const { text, redactions } = redactSecretValues(rawText);
              redacted += redactions;
              const item: MemoryImportItem = {
                text,
                source: `import:${provider}`,
                context: `${table.name}.${column}`,
              };
              if (originDate) {
                item.origin_date = originDate;
              }
              onItem(item);
              extracted++;
              totalItems++;
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
      if (redacted > 0) {
        entry.redactions = redacted;
      }
      census.push(entry);
    }

    return { census, totalItems };
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

  // Stream the JSON array to stdout item by item so the full candidate
  // set is never held in memory or serialized as one string.
  const writer = createItemsJsonStreamWriter((chunk) =>
    process.stdout.write(chunk),
  );
  let result: ReturnType<typeof extractMemoryDb>;
  try {
    result = extractMemoryDb(filePath, source, (item) =>
      writer.writeItem(item),
    );
  } catch (err) {
    process.stderr.write(
      `Error reading database: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  writer.end();

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
      if (entry.redactions && entry.redactions > 0) {
        process.stderr.write(
          `    redacted ${entry.redactions} secret-like value(s) in place\n`,
        );
      }
    } else {
      process.stderr.write(`  skipped: ${entry.table} (${entry.reason})\n`);
    }
  }
  process.stderr.write(
    `Total: ${result.totalItems} review candidates. These are candidates for creator review, not final memories.\n`,
  );
}

if (import.meta.main) {
  main();
}
