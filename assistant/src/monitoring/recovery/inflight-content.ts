/**
 * Recovery step: fold in-flight message content a crashed daemon left behind.
 *
 * A message row born in-flight carries `finalized = 0` and a `{ ref }` pointer
 * to an append-only JSONL delta file until its turn reaches the finalize seam
 * (see `daemon/inflight-message-content.ts`). A daemon that dies mid-turn
 * leaves the row `finalized = 0` with its delta file on disk. The live daemon
 * folds stranded writers from its in-memory map at the turn tail, but a crash
 * loses that map — so this step, run once from the monitor process at startup,
 * reconciles the residue.
 *
 * It runs OUT OF PROCESS from the daemon, so it cannot see live in-memory
 * writers. Two DB-observable signals stand in for that ownership knowledge:
 *
 *   - `conversations.processing_started_at` — the daemon persists this at every
 *     turn boundary precisely so out-of-process callers can detect a live turn
 *     (the same signal the resource sampler reads). A `finalized = 0` row whose
 *     conversation is mid-turn is a LIVE stream, not crash residue: skip it.
 *   - delta-file mtime — a file touched within the age floor may belong to a
 *     writer whose conversation flag we observed a beat after it cleared.
 *
 * With both guards the fold only ever touches rows no live turn owns. Genuine
 * crash residue is folded on this one pass (the `clear-stale-processing`
 * recovery step, ordered before this one in the same run, nulls stale
 * `processing_started_at` first). The rare row a reconnecting client
 * re-activated within the startup window is left as-is and reconciled by the
 * next daemon restart's run.
 *
 * Two phases:
 *   1. Fold each eligible `finalized = 0` row's resolved content inline and set
 *      `finalized = 1` without deleting its delta file.
 *   2. GC delta files no message row references, regardless of finalization
 *      state. A finalized retrospective fork can share the pending source's
 *      ref, so the file remains until every row has detached from it.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import {
  parseContentRef,
  resolveContentRefPath,
  resolveMessageContentBlocks,
} from "../../persistence/message-content-file.js";
import { getLogger } from "../../util/logger.js";
import { getConversationsDir } from "../../util/platform.js";
import { openRecoveryDb } from "./db.js";

const log = getLogger("recovery-inflight-content");

/**
 * Delta files touched within this window may belong to a live writer, so the
 * fold and the orphan GC both leave them alone. Startup residue from a crashed
 * process is always older than this, so recovery is not delayed in practice.
 */
export const DEFAULT_INFLIGHT_MIN_AGE_MS = 60_000;

export interface InflightRecoveryResult {
  /** `finalized = 0` rows folded inline and flipped to `finalized = 1`. */
  finalized: number;
  /** Delta files unreferenced by every message row and unlinked from disk. */
  filesDeleted: number;
  /** Rows left for a later run because their conversation is mid-turn. */
  skippedProcessing: number;
}

interface UnfinalizedRow {
  id: string;
  conversationId: string;
  content: string;
  processingStartedAt: number | null;
}

/** Delta-file absolute path a row's `{ ref }` content points at, or null. */
function refAbsPath(content: string): string | null {
  const ref = parseContentRef(content);
  return ref ? resolveContentRefPath(ref.ref) : null;
}

function fileMtimeMs(absPath: string): number | null {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Fold `finalized = 0` rows a crashed daemon left behind and GC orphan delta
 * files. Opens (and closes) its own handle on the daemon database — different
 * recovery steps may target different databases — and logs its own result.
 * Throws only if the schema is not yet migrated; the orchestrator treats that
 * as a failed step and retries on the next monitor start.
 */
export function recoverInflightContent(
  options: {
    minAgeMs?: number;
  } = {},
): InflightRecoveryResult {
  const db = openRecoveryDb();
  if (db == null) {
    return { finalized: 0, filesDeleted: 0, skippedProcessing: 0 };
  }
  try {
    const minAgeMs = options.minAgeMs ?? DEFAULT_INFLIGHT_MIN_AGE_MS;
    const now = Date.now();

    // Throws here (missing `finalized`/`processing_started_at` column) propagate
    // to the caller as "schema not ready yet".
    const rows = db
      .query(
        `SELECT m.id AS id,
                m.conversation_id AS conversationId,
                m.content AS content,
                c.processing_started_at AS processingStartedAt
           FROM messages m
           LEFT JOIN conversations c ON c.id = m.conversation_id
          WHERE m.finalized = 0`,
      )
      .all() as UnfinalizedRow[];

    // `AND finalized = 0` makes the write a no-op if the daemon finalized the
    // row between our read and this write; `changes` then reports 0. File
    // deletion is deferred to the all-message reference sweep below.
    const finalizeStmt = db.query(
      `UPDATE messages SET content = ?, finalized = 1
        WHERE id = ? AND finalized = 0`,
    );

    let finalized = 0;
    let skippedProcessing = 0;
    for (const row of rows) {
      // Ownership guard: a live turn on this conversation still owns the row.
      if (row.processingStartedAt != null) {
        skippedProcessing++;
        continue;
      }
      const absPath = refAbsPath(row.content);
      // Age guard: a freshly-written file may be a live writer whose
      // conversation flag we observed just after it cleared.
      if (absPath != null) {
        const mtime = fileMtimeMs(absPath);
        if (mtime != null && now - mtime < minAgeMs) {
          continue;
        }
      }
      try {
        const blocks = resolveMessageContentBlocks(row.content);
        const info = finalizeStmt.run(JSON.stringify(blocks), row.id);
        if (info.changes > 0) {
          finalized++;
        }
      } catch (err) {
        log.warn(
          { err, messageId: row.id },
          "in-flight recovery: failed to fold a row — continuing",
        );
      }
    }

    const filesDeleted = sweepOrphanDeltaFiles(db, minAgeMs, now);
    const result = { finalized, filesDeleted, skippedProcessing };
    if (finalized > 0 || filesDeleted > 0) {
      log.info(result, "Recovered in-flight message content");
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * Delete delta files no message row references. Re-reads all rows after the
 * fold so skipped pending rows and finalized rows sharing their refs retain
 * the file, and honours the same age floor so a live writer's file is never
 * unlinked mid-stream.
 */
function sweepOrphanDeltaFiles(
  db: Database,
  minAgeMs: number,
  now: number,
): number {
  const retained = new Set<string>();
  // parseContentRef rejects every value whose first character is not `{`.
  // Apply that exact fast-path in SQL so large historical inline arrays do not
  // cross into the monitor process merely to be rejected in JavaScript.
  const rows = db
    .query(`SELECT content FROM messages WHERE substr(content, 1, 1) = '{'`)
    .all() as Array<{ content: string }>;
  for (const row of rows) {
    const absPath = refAbsPath(row.content);
    if (absPath != null) {
      retained.add(absPath);
    }
  }

  const conversationsDir = getConversationsDir();
  let convDirNames: string[];
  try {
    convDirNames = readdirSync(conversationsDir);
  } catch {
    return 0; // no conversations directory yet
  }

  let deleted = 0;
  for (const name of convDirNames) {
    const inflightDir = join(conversationsDir, name, "inflight");
    let files: string[];
    try {
      files = readdirSync(inflightDir);
    } catch {
      continue; // not a directory, or has no inflight subdirectory
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const absPath = resolve(inflightDir, file);
      if (retained.has(absPath)) {
        continue;
      }
      const mtime = fileMtimeMs(absPath);
      if (mtime != null && now - mtime < minAgeMs) {
        continue; // too fresh — may belong to a live turn
      }
      try {
        rmSync(absPath, { force: true });
        deleted++;
      } catch (err) {
        log.warn(
          { err, absPath },
          "in-flight recovery: failed to GC orphan delta file — continuing",
        );
      }
    }
  }
  return deleted;
}
