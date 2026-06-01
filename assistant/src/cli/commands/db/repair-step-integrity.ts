/**
 * Repair step: integrity check.
 *
 * Runs `PRAGMA integrity_check` on a read-only handle. The pragma is the
 * authoritative SQLite corruption probe — it walks every page, verifies
 * b-tree linkage, checks index ↔ table consistency, and surfaces results
 * as one or more rows of text. The canonical "everything ok" response is
 * a single row containing the literal string "ok"; any other rows are
 * error messages we surface verbatim.
 *
 * We use the full `integrity_check` rather than `quick_check` because the
 * user typing `assistant db repair` is explicitly signing up for a slow
 * thorough probe. On the workspace's current ~4 GB DB the full check runs
 * in single-digit-minutes; that's acceptable for "the DB might be broken,
 * please tell me everything that's wrong".
 *
 * The step never mutates the database. If corruption is found the step
 * returns a non-halting error — subsequent steps may still produce useful
 * work even on a partially-corrupt DB.
 */

import { Database } from "bun:sqlite";

import type { RepairContext, RepairStep, StepResult } from "./repair-steps.js";

/**
 * Maximum number of corruption error lines to surface in the human output
 * before truncating with a "+N more" suffix. The JSON payload always
 * carries the full list; this cap only affects the rendered text so a
 * massively corrupt DB doesn't drown the terminal.
 */
const MAX_REPORTED_ERROR_LINES = 20;

async function runIntegrityCheck(ctx: RepairContext): Promise<StepResult> {
  // Open-failure (file unreadable, file is a directory, header so corrupt
  // SQLite refuses to attach) needs to surface as a normal step error, not
  // get caught by the runner's generic "step threw — this is a bug"
  // fallback. Catch the constructor failure and convert it into a
  // structured diagnostic.
  let db: Database;
  try {
    db = new Database(ctx.dbPath, { readonly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      summary: "could not open database for integrity check",
      detailLines: [msg],
      data: {
        pageCount: 0,
        errorCount: 1,
        errors: [msg],
        openFailed: true,
      },
    };
  }

  try {
    // `PRAGMA integrity_check` returns rows of a single TEXT column also
    // named `integrity_check`. When the DB is healthy this is exactly one
    // row whose value is the literal "ok"; any other shape means errors.
    //
    // Severely corrupted DBs (header damaged, b-tree root unreadable) can
    // cause the pragma itself to throw "database disk image is malformed"
    // before yielding any rows. Catch that and surface it as the
    // corruption signal it actually is — not a step bug, the DB telling
    // us it's structurally invalid.
    let messages: string[];
    try {
      const rows = db
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .all();
      messages = rows.map((r) => r.integrity_check);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const pageCount = safePageCount(db);
      return {
        status: "error",
        summary: "database is too corrupt to complete integrity check",
        detailLines: [msg, `page count: ${pageCount.toLocaleString("en-US")}`],
        data: {
          pageCount,
          errorCount: 1,
          errors: [msg],
          checkFailed: true,
        },
      };
    }

    const healthy = messages.length === 1 && messages[0] === "ok";
    const pageCount = safePageCount(db);

    if (healthy) {
      return {
        status: "ok",
        summary: "no corruption detected",
        detailLines: [`scanned ${pageCount.toLocaleString("en-US")} pages`],
        data: { pageCount, errorCount: 0 },
      };
    }

    const truncated = messages.slice(0, MAX_REPORTED_ERROR_LINES);
    const detailLines =
      messages.length > MAX_REPORTED_ERROR_LINES
        ? [
            ...truncated,
            `+ ${messages.length - MAX_REPORTED_ERROR_LINES} more (use --json for full list)`,
          ]
        : truncated;

    return {
      status: "error",
      summary: `${messages.length} integrity violation${messages.length === 1 ? "" : "s"} reported`,
      detailLines,
      data: {
        pageCount,
        errorCount: messages.length,
        errors: messages,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * `PRAGMA page_count` is cheap and works even on damaged DBs (it reads
 * from the header), but on truly malformed files it can throw too. Wrap
 * it so the integrity step always has a number to report.
 */
function safePageCount(db: Database): number {
  try {
    return (
      db.query<{ page_count: number }, []>("PRAGMA page_count").get()
        ?.page_count ?? 0
    );
  } catch {
    return 0;
  }
}

export const integrityCheckStep: RepairStep = {
  name: "integrity-check",
  description: "Walk every database page and verify b-tree consistency",
  run: runIntegrityCheck,
};
