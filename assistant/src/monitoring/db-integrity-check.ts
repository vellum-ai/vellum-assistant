/**
 * `PRAGMA quick_check` probe for a SQLite database file, runnable as a
 * standalone subprocess (`bun run db-integrity-check.ts <db-path>`) so the
 * synchronous page walk never blocks the monitor's event loop. Prints the
 * JSON-encoded {@link IntegritySampleResult} (or `null`) to stdout.
 *
 * quick_check rather than the full `integrity_check` the `assistant db
 * repair` step runs: quick_check skips the index ↔ table cross-verification,
 * which is the expensive half on a multi-GB database, while still walking
 * every page and catching the b-tree damage that makes a database unusable.
 * A background sweep nobody asked for has to stay cheap.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

/** Cap on quick_check error rows — a wrecked DB reports thousands. */
const MAX_ERRORS = 10;

/**
 * Cap on each error message's UTF-8 byte length. With MAX_ERRORS rows this
 * bounds the whole error payload well under the 4096-byte watchdog `detail`
 * limit (WATCHDOG_DETAIL_MAX_JSON_BYTES) — an oversized detail is silently
 * dropped by the platform, which would selectively erase the most-corrupted
 * databases from the prevalence metric. Bytes, not `String.length`: ten
 * 160-character CJK messages would otherwise serialize to ~4.9 KB.
 */
const MAX_ERROR_BYTES = 160;

/** Truncate to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) {
      break;
    }
    out += ch;
    bytes += b;
  }
  return out;
}

export function boundErrors(messages: string[]): string[] {
  return messages
    .slice(0, MAX_ERRORS)
    .map((m) => truncateToBytes(m, MAX_ERROR_BYTES));
}

export interface IntegritySampleResult {
  ok: boolean;
  errors: string[];
  pageCount: number;
  durationMs: number;
}

function errCode(err: unknown): unknown {
  return (err as { code?: unknown }).code;
}

/**
 * Lock contention with the daemon (checkpoint restarts, WAL recovery) is not
 * corruption — mapping it to `ok: false` would inflate the very prevalence
 * number this probe exists to measure. Busy maps to "no sample" instead.
 */
function isBusy(err: unknown): boolean {
  const code = errCode(err);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/**
 * True only for errors that establish structural corruption. Operational
 * failures (I/O errors, permissions, out-of-memory) say nothing about the
 * database's integrity and must not count as corrupt samples.
 */
function isCorruption(err: unknown): boolean {
  const code = errCode(err);
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("malformed") || msg.includes("not a database");
}

/**
 * Run `PRAGMA quick_check` against `dbPath` on a read-only handle.
 *
 * Only genuine corruption signals come back as `ok: false`: quick_check
 * error rows, or an open/query failure whose error identifies the file as
 * structurally invalid ("database disk image is malformed", "file is not a
 * database"). Returns null — "no sample" — when the file does not exist,
 * the database is locked past the busy timeout, or the failure is
 * operational (I/O, permissions, memory); the caller stays due and retries
 * next poll.
 */
export function runIntegrityCheck(
  dbPath: string,
): IntegritySampleResult | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  const startedAt = Date.now();
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    if (!isCorruption(err) || isBusy(err)) {
      return null;
    }
    return {
      ok: false,
      errors: boundErrors([err instanceof Error ? err.message : String(err)]),
      pageCount: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const rows = db
      .query<{ quick_check: string }, []>(`PRAGMA quick_check(${MAX_ERRORS})`)
      .all();
    const messages = rows.map((r) => r.quick_check);
    const healthy = messages.length === 1 && messages[0] === "ok";
    return {
      ok: healthy,
      errors: healthy ? [] : boundErrors(messages),
      pageCount: pageCount(db),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (!isCorruption(err) || isBusy(err)) {
      return null;
    }
    return {
      ok: false,
      errors: boundErrors([err instanceof Error ? err.message : String(err)]),
      pageCount: pageCount(db),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    db.close();
  }
}

/**
 * `PRAGMA page_count` is cheap and works even on damaged DBs (it reads from
 * the header), but on truly malformed files it can throw too.
 */
function pageCount(db: Database): number {
  try {
    return (
      db.query<{ page_count: number }, []>("PRAGMA page_count").get()
        ?.page_count ?? 0
    );
  } catch {
    return 0;
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(runIntegrityCheck(process.argv[2] ?? "")));
}
