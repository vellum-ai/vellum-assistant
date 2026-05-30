/**
 * `assistant db status` — read-only inspection of the assistant SQLite database.
 *
 * Designed for recovery / triage: opens the DB file directly via bun:sqlite in
 * read-only mode and never goes through the assistant runtime. This is exactly
 * the moment you most want it to work — when the database is broken, the
 * daemon often won't start, so IPC isn't an option.
 *
 * Reports:
 *   - file path, sizes (.db / .db-wal / .db-shm)
 *   - owner uid/gid + mode (catches "daemon ran as root" UID-isolation
 *     regressions on shared volumes)
 *   - SQLite version and key pragmas (journal_mode, page_size, etc.)
 *   - table count + 5 largest tables (by `dbstat` bytes when compiled in,
 *     otherwise by row count — Bun's bundled SQLite omits dbstat, so most
 *     callers will see the row-count path today)
 *   - latest applied workspace migration (proxy for schema version, read
 *     from the `memory_checkpoints` rows the migration runner writes)
 *   - file mtime + age, for "is this DB live?" triage at a glance
 *
 * If the DB file is missing, exits with code 1 after a loud error. If the file
 * exists but bun:sqlite can't open it (corrupt header, etc.), exits with the
 * underlying error message — full integrity checking lands in `db repair`.
 */

import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

import type { Command } from "commander";

import { getDbPath } from "../../../util/platform.js";
import { red } from "../../lib/cli-colors.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  formatAge,
  formatBytes,
  formatCount,
  formatMode,
  formatTimestampUtc,
} from "./format.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

type SizingMethod = "bytes" | "rows";

interface FileFacts {
  path: string;
  exists: boolean;
  size: number;
  walSize: number;
  shmSize: number;
  uid: number;
  gid: number;
  mode: number;
  mtimeMs: number;
}

interface DbFacts {
  sqliteVersion: string;
  journalMode: string;
  synchronous: string;
  pageSize: number;
  pageCount: number;
  walAutocheckpoint: number;
  mmapSize: number;
  tableCount: number;
  latestMigration: { key: string; updatedAtMs: number } | null;
  largest: { name: string; metric: number }[];
  sizingMethod: SizingMethod;
}

interface StatusReport {
  file: FileFacts;
  db: DbFacts | null;
}

// ---------------------------------------------------------------------------
// Probes (read-only)
// ---------------------------------------------------------------------------

function readFileFacts(path: string): FileFacts {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      size: 0,
      walSize: 0,
      shmSize: 0,
      uid: 0,
      gid: 0,
      mode: 0,
      mtimeMs: 0,
    };
  }
  const st = statSync(path);
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  return {
    path,
    exists: true,
    size: st.size,
    walSize: existsSync(walPath) ? statSync(walPath).size : 0,
    shmSize: existsSync(shmPath) ? statSync(shmPath).size : 0,
    uid: st.uid,
    gid: st.gid,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
  };
}

/** Decode the integer value of `PRAGMA synchronous` to a name. */
function synchronousName(level: number): string {
  return ["off", "normal", "full", "extra"][level] ?? String(level);
}

function readDbFacts(path: string): DbFacts {
  const db = new Database(path, { readonly: true });
  try {
    const sqliteVersion =
      db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ??
      "?";
    const journalMode =
      db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
        ?.journal_mode ?? "?";
    const syncRow = db
      .query<{ synchronous: number }, []>("PRAGMA synchronous")
      .get();
    const pageSize =
      db.query<{ page_size: number }, []>("PRAGMA page_size").get()
        ?.page_size ?? 0;
    const pageCount =
      db.query<{ page_count: number }, []>("PRAGMA page_count").get()
        ?.page_count ?? 0;
    const walAutocheckpoint =
      db
        .query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint")
        .get()?.wal_autocheckpoint ?? 0;
    const mmapSize =
      db.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()
        ?.mmap_size ?? 0;

    // Table count (excluding internal sqlite_* tables).
    const tableCount =
      db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM sqlite_master
           WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get()?.n ?? 0;

    // Latest applied migration. The memory migration runner writes
    // `migration_<name>` rows into `memory_checkpoints` with value='1' on
    // success. If `memory_checkpoints` doesn't exist yet (pre-migration
    // database), best-effort skip without erroring out.
    let latestMigration: DbFacts["latestMigration"] = null;
    try {
      const row = db
        .query<{ key: string; updated_at: number }, []>(
          `SELECT key, updated_at FROM memory_checkpoints
           WHERE key LIKE 'migration_%' AND value = '1'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get();
      if (row) {
        latestMigration = { key: row.key, updatedAtMs: row.updated_at };
      }
    } catch {
      latestMigration = null;
    }

    // Largest tables. Prefer `dbstat` when the runtime SQLite has it
    // compiled in (gives true byte sizes). Bun's bundled SQLite omits
    // dbstat, so we fall back to COUNT(*). Detect at runtime, not via
    // PRAGMA compile_options string parsing, because the latter has
    // historically had naming drift across versions.
    let sizingMethod: SizingMethod = "rows";
    let largest: { name: string; metric: number }[] = [];

    try {
      const dbstatRows = db
        .query<{ name: string; bytes: number }, []>(
          `SELECT name, SUM(pgsize) AS bytes FROM dbstat
           WHERE name NOT LIKE 'sqlite_%'
           GROUP BY name ORDER BY bytes DESC LIMIT 5`,
        )
        .all();
      largest = dbstatRows.map((r) => ({ name: r.name, metric: r.bytes }));
      sizingMethod = "bytes";
    } catch {
      // Fall back to row count.
      const tables = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all();
      const counts: { name: string; metric: number }[] = [];
      for (const t of tables) {
        try {
          const c = db
            .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t.name}"`)
            .get();
          counts.push({ name: t.name, metric: c?.n ?? 0 });
        } catch {
          // Skip tables we can't count (virtual tables backed by something
          // unavailable, etc.). Keep going so one bad table doesn't kill
          // the whole report.
        }
      }
      counts.sort((a, b) => b.metric - a.metric);
      largest = counts.slice(0, 5);
      sizingMethod = "rows";
    }

    return {
      sqliteVersion,
      journalMode,
      synchronous: synchronousName(syncRow?.synchronous ?? -1),
      pageSize,
      pageCount,
      walAutocheckpoint,
      mmapSize,
      tableCount,
      latestMigration,
      largest,
      sizingMethod,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 17;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}\n`;
}

function renderHuman(report: StatusReport): string {
  const { file, db } = report;
  let out = "";

  out += row("Path", file.path);
  out += row("Size", formatBytes(file.size));
  out += row("WAL size", formatBytes(file.walSize));
  out += row("SHM size", formatBytes(file.shmSize));
  out += row(
    "Owner",
    `uid=${file.uid} gid=${file.gid}  (mode ${formatMode(file.mode)})`,
  );
  out += row(
    "Modified",
    `${formatTimestampUtc(file.mtimeMs)}  (${formatAge(Date.now() - file.mtimeMs)})`,
  );

  if (!db) return out;

  out += "\n";
  out += row("SQLite", db.sqliteVersion);
  out += row("Journal", db.journalMode);
  out += row("Sync", db.synchronous);
  out += row("Page size", String(db.pageSize));
  out += row("Page count", formatCount(db.pageCount));
  out += row(
    "WAL checkpoint",
    `every ${formatCount(db.walAutocheckpoint)} pages`,
  );
  out += row("mmap_size", formatBytes(db.mmapSize));

  out += "\n";
  out += row("Tables", String(db.tableCount));
  if (db.latestMigration) {
    out += row(
      "Schema (last)",
      `${db.latestMigration.key.replace(/^migration_/, "")}  (${formatAge(Date.now() - db.latestMigration.updatedAtMs)})`,
    );
  } else {
    out += row("Schema (last)", "unknown");
  }

  out += "\n";
  const sizingHeader =
    db.sizingMethod === "bytes"
      ? "Largest tables (by bytes):"
      : "Largest tables (by row count; dbstat not compiled in):";
  out += `${sizingHeader}\n`;
  const nameWidth = Math.max(16, ...db.largest.map((t) => t.name.length));
  for (const t of db.largest) {
    const metric =
      db.sizingMethod === "bytes"
        ? formatBytes(t.metric)
        : `${formatCount(t.metric)} rows`;
    out += `  ${t.name.padEnd(nameWidth)}  ${metric}\n`;
  }

  return out;
}

function renderMissing(path: string): string {
  return (
    `${red("ERROR")}  Database not found at ${path}\n\n` +
    `The assistant SQLite database is missing. The daemon will create a fresh,\n` +
    `empty database on next start, but any existing rows are unrecoverable from\n` +
    `SQLite alone.\n\n` +
    `If you have a backup, restore it:\n` +
    `  assistant backup list\n\n` +
    `Conversation skeletons can also be re-derived from the disk-view at\n` +
    `\`/workspace/conversations\` once \`assistant db repair\` lands.\n`
  );
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function registerDbStatus(parent: Command): void {
  parent
    .command("status")
    .description(
      "Show database path, size, key pragmas, and the 5 largest tables",
    )
    .action(function (this: Command) {
      const file = readFileFacts(getDbPath());

      if (!file.exists) {
        if (shouldOutputJson(this)) {
          const report: StatusReport = { file, db: null };
          writeOutput(this, report);
        } else {
          process.stderr.write(renderMissing(file.path));
        }
        process.exit(1);
      }

      let db: DbFacts;
      try {
        db = readDbFacts(file.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(this)) {
          const report: StatusReport = { file, db: null };
          writeOutput(this, { ...report, openError: msg });
        } else {
          process.stderr.write(
            `${red("ERROR")}  Failed to open ${file.path}: ${msg}\n` +
              `\nThe file exists but bun:sqlite couldn't open it. Run\n` +
              `\`assistant db repair\` (when available) for a full integrity check.\n`,
          );
        }
        process.exit(1);
      }

      const report: StatusReport = { file, db };
      if (shouldOutputJson(this)) {
        writeOutput(this, report);
      } else {
        process.stdout.write(renderHuman(report));
      }
    });
}
