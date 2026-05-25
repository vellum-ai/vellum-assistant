/**
 * Memory v3 — co-activation store.
 *
 * Best-effort read/write helpers over `memory_v3_coactivation` (migration
 * 262). Each row is a pass-1 → pass-N co-activation pair observed during a
 * single v3 retrieval loop: a `target_slug` first surfaced on a later descent
 * pass was co-selected alongside a `source_slug` that surfaced on pass 1,
 * `pass_gap = passOf(target) − passOf(source)`.
 *
 * This is the raw gradient signal — edge-learning reconciles it into curated
 * graph edge weights later. Writes are off the retrieval critical path: a
 * failed insert here must never abort the turn on top of a successful
 * retrieval the caller already depends on.
 */

import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-v3-coactivation");

/** One co-activation pair to persist. */
export interface CoactivationRow {
  conversationId: string;
  turn: number;
  sourceSlug: string;
  targetSlug: string;
  passGap: number;
  /** Usefulness flag. 0 at emit time; reconciled later by edge-learning. */
  used: number;
  createdAt: number;
}

/** A persisted co-activation row, as read back from the table. */
export interface PersistedCoactivationRow {
  id: number;
  conversationId: string;
  turn: number;
  sourceSlug: string;
  targetSlug: string;
  passGap: number;
  used: number;
  createdAt: number;
}

/**
 * Append co-activation rows. Best-effort — a SQLite write must never abort the
 * agent turn on top of a successful retrieval the rest of the caller depends
 * on. Mirrors {@link recordInjectionEvents}.
 */
export function recordCoactivations(
  database: DrizzleDb,
  rows: readonly CoactivationRow[],
): void {
  if (rows.length === 0) return;
  try {
    const raw = getSqliteFrom(database);
    const insert = raw.prepare(
      `INSERT INTO memory_v3_coactivation
        (conversation_id, turn, source_slug, target_slug, pass_gap, used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const append = raw.transaction((items: readonly CoactivationRow[]) => {
      for (const r of items) {
        insert.run(
          r.conversationId,
          r.turn,
          r.sourceSlug,
          r.targetSlug,
          r.passGap,
          r.used,
          r.createdAt,
        );
      }
    });
    append(rows);
  } catch (err) {
    log.warn(
      { err, rowCount: rows.length },
      "failed to record co-activations; continuing",
    );
  }
}

/**
 * Read co-activation rows, oldest first. When `since` is provided, only rows
 * with `created_at >= since` are returned.
 */
export function readCoactivations(
  database: DrizzleDb,
  since?: number,
): PersistedCoactivationRow[] {
  const raw = getSqliteFrom(database);
  const where = since !== undefined ? `WHERE created_at >= ?` : ``;
  const params = since !== undefined ? [since] : [];
  const rows = raw
    .query(
      `SELECT id, conversation_id, turn, source_slug, target_slug,
              pass_gap, used, created_at
        FROM memory_v3_coactivation
        ${where}
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...params) as Array<{
    id: number;
    conversation_id: string;
    turn: number;
    source_slug: string;
    target_slug: string;
    pass_gap: number;
    used: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    turn: r.turn,
    sourceSlug: r.source_slug,
    targetSlug: r.target_slug,
    passGap: r.pass_gap,
    used: r.used,
    createdAt: r.created_at,
  }));
}
