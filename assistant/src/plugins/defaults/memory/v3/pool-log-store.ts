/**
 * Per-turn audit record of the memory-v3 selector's candidate pool.
 *
 * `memory_v3_selections` keeps only the winners of each turn's forced-tool
 * select, and the selector call itself is not written to `llm_request_logs`,
 * so without this record a retrieval miss can only be diagnosed by rebuilding
 * the lanes offline. `memory_v3_pools` (memory connection, one row per
 * `(conversation, turn)`) stores every candidate the selector saw, in pool
 * order, with its lane, its matched section, and whether it was chosen.
 *
 * Writes are best-effort (a failure logs a warning and never fails the turn)
 * and resolve the memory connection via `memorySqliteOrNull`, matching the
 * selections writer in `shadow-plugin.ts`. `message_id` is written NULL and
 * stamped at turn end by `backfillMemoryV3SelectionMessageId`, in the same
 * batch as the selection rows.
 *
 * Rows are per-turn diagnostics (roughly 10KB each) with no retention job;
 * a conversation delete purges them with the other conversation-keyed memory
 * tables (`conversation-memory-purge.ts`).
 */

import { getLogger } from "../logging.js";
import { memorySqliteOrNull } from "../memory-db.js";
import type { OrchestrateResult } from "./orchestrate.js";
import type { FinderLane, Slug } from "./types.js";

const log = getLogger("memory-v3-pool-log");

/** Where a pooled candidate lived: a stable-prefix lane, or the finder lane
 *  that surfaced it. */
export type PoolLane = "core" | "hot" | "fresh" | "always" | FinderLane;

/** One candidate as the selector saw it, in the persisted JSON shape. */
export interface PoolCandidateRecord {
  slug: Slug;
  lane: PoolLane;
  /** Heading of the matched section a finder lane surfaced (`""` for the
   *  lead); null for stable-prefix cards and finder lines with no matched
   *  section. */
  section_title: string | null;
  section_ordinal: number | null;
  /** Whether the selector kept this candidate's page. */
  chosen: boolean;
}

export interface PoolRecord {
  /** Every candidate in pool order: core, hot, fresh, and always-candidate
   *  cards, then the finder tail. */
  candidates: PoolCandidateRecord[];
  /** `candidates.length`: the pool size the selector was shown. */
  pool_size: number;
  /** Distinct pages the selector kept (one `memory_v3_selections` row each). */
  selected_count: number;
}

/**
 * Build the turn's pool record from an orchestrate result. The stable prefix
 * comes first in cache order (core, hot, fresh, always-candidate) as
 * whole-page cards with no section; the finder tail follows in surfacing
 * order, each line tagged with the lane that surfaced it and the slug's
 * matched section. A finder hit on a stable-prefix page therefore appears
 * twice, exactly as the selector saw it. `chosen` is slug membership in the
 * selection set, so every entry for a selected page reads chosen.
 */
export function buildPoolRecord(result: OrchestrateResult): PoolRecord {
  const selected = new Set<Slug>(result.selections.map((s) => s.slug));
  const card = (slug: Slug, lane: PoolLane): PoolCandidateRecord => ({
    slug,
    lane,
    section_title: null,
    section_ordinal: null,
    chosen: selected.has(slug),
  });
  const { core, hot, fresh, always, finder } = result.lanes;
  const candidates: PoolCandidateRecord[] = [
    ...core.map((slug) => card(slug, "core")),
    ...hot.map((slug) => card(slug, "hot")),
    ...fresh.map((slug) => card(slug, "fresh")),
    ...always.map((slug) => card(slug, "always")),
    ...finder.map((candidate): PoolCandidateRecord => {
      const section = result.matchedSections.get(candidate.slug);
      return {
        slug: candidate.slug,
        lane: candidate.lane,
        section_title: section?.title ?? null,
        section_ordinal: section?.ordinal ?? null,
        chosen: selected.has(candidate.slug),
      };
    }),
  ];
  return {
    candidates,
    pool_size: candidates.length,
    selected_count: result.selections.length,
  };
}

/**
 * Persist the turn's pool record. Best-effort: an unavailable memory database
 * or a failed statement drops the record rather than affecting the turn.
 */
export function writePool(
  conversationId: string,
  turn: number,
  record: PoolRecord,
): void {
  try {
    const raw = memorySqliteOrNull("writePool");
    if (!raw) {
      return;
    }
    // PK is (conversation_id, turn); OR REPLACE keeps a retried turn
    // idempotent and resets `message_id` for the turn-end backfill.
    raw
      .query(
        /*sql*/ `
        INSERT OR REPLACE INTO memory_v3_pools (
          conversation_id, turn, message_id, created_at,
          pool_size, selected_count, candidates_json
        ) VALUES (?, ?, NULL, ?, ?, ?, ?)
      `,
      )
      .run(
        conversationId,
        turn,
        Date.now(),
        record.pool_size,
        record.selected_count,
        JSON.stringify(record.candidates),
      );
  } catch (err) {
    log.warn({ err }, "failed to write memory-v3 pool; continuing");
  }
}

interface PoolRow {
  pool_size: number;
  selected_count: number;
  candidates_json: string;
}

/**
 * Read the pool record for an exact `(conversation, turn)`. Returns `null`
 * when the turn has no row (it predates pool logging) or the memory connection
 * is unavailable. Best-effort like the write: a failed read or an unreadable
 * `candidates_json` logs a warning and reads as `null`, so the diagnostic can
 * never break the inspector's selection view.
 */
export function readPoolForTurn(
  conversationId: string,
  turn: number,
): PoolRecord | null {
  const raw = memorySqliteOrNull("readPoolForTurn");
  if (!raw) {
    return null;
  }
  try {
    const row = raw
      .query(
        /*sql*/ `
        SELECT pool_size, selected_count, candidates_json FROM memory_v3_pools
        WHERE conversation_id = ? AND turn = ?
      `,
      )
      .get(conversationId, turn) as PoolRow | null;
    if (!row) {
      return null;
    }
    const candidates: unknown = JSON.parse(row.candidates_json);
    if (!Array.isArray(candidates)) {
      throw new Error("candidates_json is not an array");
    }
    return {
      candidates: candidates as PoolCandidateRecord[],
      pool_size: row.pool_size,
      selected_count: row.selected_count,
    };
  } catch (err) {
    log.warn(
      { err, conversationId, turn },
      "failed to read memory-v3 pool; treating the turn as unrecorded",
    );
    return null;
  }
}
