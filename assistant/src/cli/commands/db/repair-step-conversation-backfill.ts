/**
 * Repair step: conversation backfill from the on-disk view.
 *
 * Each conversation directory under `<workspace>/conversations/<id>/` holds
 * a `meta.json` and `messages.jsonl` written by the runtime as the source
 * of truth for the disk view. If the SQLite database was wiped, restored
 * from an old backup, or otherwise lost the `conversations`/`messages`
 * rows, we can replay the on-disk files to reconstruct them.
 *
 * The core recovery logic lives in `workspace/recovery/conversations-from-disk.ts`
 * and is shared with workspace migration 028 (which runs the same pass at
 * startup). This step opens its own read-write bun:sqlite handle so the
 * command works when the daemon is down — the whole point of the local
 * transport.
 *
 * Idempotent: existing conversation rows are skipped without modification.
 */

import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../../memory/schema.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { recoverConversationsFromDisk } from "../../../workspace/recovery/conversations-from-disk.js";
import type { RepairContext, RepairStep, StepResult } from "./repair-steps.js";

/**
 * Cap on warning lines surfaced in the human-mode output. The JSON payload
 * carries the full list (subject to `WARNING_CAP_TOTAL`) so scripted callers
 * never lose detail.
 */
const MAX_REPORTED_WARNING_LINES = 20;

/**
 * Hard cap on warnings retained in memory, even for the JSON payload.
 * Prevents a workspace with thousands of malformed entries from blowing
 * memory on the report object.
 */
const WARNING_CAP_TOTAL = 500;

async function runConversationBackfill(
  ctx: RepairContext,
): Promise<StepResult> {
  // Open RW so we can insert recovered rows. Mirror the daemon's pragmas
  // for consistent journal/FK behavior — anything else risks subtle drift
  // between the migration path and this CLI path.
  let sqlite: Database;
  try {
    sqlite = new Database(ctx.dbPath);
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA synchronous=FULL");
    sqlite.exec("PRAGMA busy_timeout=5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      summary: "could not open database for conversation backfill",
      detailLines: [msg],
      data: {
        recovered: 0,
        skipped: 0,
        errors: 1,
        warnings: [msg],
        openFailed: true,
      },
    };
  }

  try {
    const db = drizzle(sqlite, { schema });
    const workspaceDir = getWorkspaceDir();

    const result = recoverConversationsFromDisk(workspaceDir, db, {
      warningCap: WARNING_CAP_TOTAL,
    });

    const summary =
      result.recovered === 0 && result.errors === 0
        ? `nothing to backfill (${result.skipped} on-disk conversation${result.skipped === 1 ? "" : "s"} already present)`
        : `recovered ${result.recovered}, skipped ${result.skipped}, ${result.errors} error${result.errors === 1 ? "" : "s"}`;

    const truncatedWarnings = result.warnings.slice(
      0,
      MAX_REPORTED_WARNING_LINES,
    );
    const detailLines =
      result.warnings.length > MAX_REPORTED_WARNING_LINES
        ? [
            ...truncatedWarnings,
            `+ ${result.warnings.length - MAX_REPORTED_WARNING_LINES} more (use --json for full list)`,
          ]
        : truncatedWarnings;

    // Errors during insert are surfaced as a non-halting failure so later
    // steps still run. Warnings without errors (malformed JSONL lines,
    // missing meta.json) are not themselves a failure — they're skips.
    if (result.errors > 0) {
      return {
        status: "error",
        summary,
        detailLines,
        data: {
          recovered: result.recovered,
          skipped: result.skipped,
          errors: result.errors,
          warnings: result.warnings,
        },
      };
    }

    return {
      status: "ok",
      summary,
      detailLines,
      data: {
        recovered: result.recovered,
        skipped: result.skipped,
        errors: result.errors,
        warnings: result.warnings,
      },
    };
  } finally {
    sqlite.close();
  }
}

export const conversationBackfillStep: RepairStep = {
  name: "conversation-backfill",
  description:
    "Replay workspace/conversations/<id>/{meta.json,messages.jsonl} into SQLite",
  run: runConversationBackfill,
};
