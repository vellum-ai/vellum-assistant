/**
 * Per-turn audit record of the memory-v3 selector's candidate pool.
 *
 * `memory_v3_selections` keeps only the winners of each turn's forced-tool
 * select, and the selector call itself is not written to `llm_request_logs`,
 * so without this record a retrieval miss can only be diagnosed by rebuilding
 * the lanes offline. `memory_v3_pools` (memory connection, one row per
 * `(conversation, turn)`) stores every candidate the selector saw, in pool
 * order (a page hit on several sections has one entry per section), with its
 * lane, its matched section, and whether it was chosen, plus
 * `selector_ran`: whether the selector judged that pool at all. A turn the
 * injection gate hard-skipped never assembles a pool, so its row is an empty
 * pool with `selector_ran = 0`; the row exists so the inspector can show the
 * negative verdict rather than nothing.
 *
 * The row is written by `writeTurnLog` in `shadow-plugin.ts`, in one
 * transaction with the turn's `memory_v3_selections` rows: a turn observed
 * again replaces both together, so the pool's `chosen` flags and the
 * selection rows always describe the same observation. That writer is
 * best-effort (a failure logs a warning, leaves the earlier rows in place,
 * and never fails the turn). Reads resolve the memory connection via
 * `memorySqliteOrNull` and degrade to `null`. `message_id` is written NULL
 * and stamped at turn end by `backfillMemoryV3SelectionMessageId`, in the
 * same batch as the selection rows, so a turn's pool can be read by its
 * message id even when the turn logged no selections.
 *
 * Rows are per-turn diagnostics (roughly 10KB each) with no retention job;
 * a conversation delete purges them with the other conversation-keyed memory
 * tables (`conversation-memory-purge.ts`).
 */

import { getLogger } from "../logging.js";
import type { MemorySqlite } from "../memory-db.js";
import type { OrchestrateResult } from "./orchestrate.js";
import {
  ensuredMemorySqlite,
  ensureMemoryV3PoolsSchemaOnce,
  memoryReader,
} from "./plugin-schema.js";
import { type FinderLane, sectionKey, type Slug } from "./types.js";

const log = getLogger("memory-v3-pool-log");

/** Where a pooled candidate lived: a stable-prefix lane, or the finder lane
 *  that surfaced it. */
export type PoolLane = "core" | "hot" | "fresh" | "always" | FinderLane;

/** One candidate as the selector saw it, in the persisted JSON shape. */
export interface PoolCandidateRecord {
  slug: Slug;
  lane: PoolLane;
  /** Heading of the matched section this finder line carries (`""` for the
   *  lead); null for stable-prefix cards and section-less finder lines. */
  section_title: string | null;
  /** The matched section's `sectionKey` (`types.ts`), which tells a repeated
   *  heading's lines (`Topic`, `Topic#1`) apart where the title cannot; null
   *  exactly when `section_title` is, and absent on rows written before the
   *  field existed. */
  section_key: string | null;
  /** Whether the selector kept this line: for a finder line carrying a
   *  section, whether that section was selected; for a card or a
   *  section-less line, whether its page was kept at all. */
  chosen: boolean;
}

export interface PoolRecord {
  /** Every candidate in pool order: core, hot, fresh, and always-candidate
   *  cards, then the finder tail. Empty when no pool reached the selector. */
  candidates: PoolCandidateRecord[];
  /** `candidates.length`: the pool size the selector was shown. */
  pool_size: number;
  /** Distinct pages the selector kept (one `memory_v3_selections` row each). */
  selected_count: number;
  /** Whether the selector judged the pool (`OrchestrateResult.selectorRan`).
   *  False for a closed-gate hard skip, an empty pool, and the
   *  disabled-selector passthrough. */
  selector_ran: boolean;
}

/** A persisted pool row: the turn it was written for and its record. */
interface StoredPool {
  turn: number;
  record: PoolRecord;
}

/**
 * Build the turn's pool record from an orchestrate result. The stable prefix
 * comes first in cache order (core, hot, fresh, always-candidate) as
 * whole-page cards with no section; the finder tail follows in surfacing
 * order, each line tagged with the lane that surfaced it and the section it
 * carries. A finder hit on a stable-prefix page therefore appears twice, and
 * a page hit on several sections once per section, exactly as the selector
 * saw it. A card or a section-less line reads chosen when its page was kept;
 * a line carrying a section reads chosen when that section was selected.
 *
 * When the selector did not run and nothing was selected, no pool reached it:
 * either the injection gate hard-skipped selection (the result's lanes still
 * carry the stable prefix, which the selector never saw) or the pool was
 * empty. The record is then empty rather than a list of candidates marked
 * unchosen, which would read as a rejection the selector never made. The
 * disabled-selector passthrough keeps every pooled candidate as a selection,
 * so it still records its pool.
 */
export function buildPoolRecord(result: OrchestrateResult): PoolRecord {
  if (!result.selectorRan && result.selections.length === 0) {
    return {
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    };
  }
  const selected = new Map<Slug, Set<string>>(
    result.selections.map((s) => [
      s.slug,
      new Set(s.sections.map((section) => sectionKey(section))),
    ]),
  );
  const card = (slug: Slug, lane: PoolLane): PoolCandidateRecord => ({
    slug,
    lane,
    section_title: null,
    section_key: null,
    chosen: selected.has(slug),
  });
  const { core, hot, fresh, always, finder } = result.lanes;
  const candidates: PoolCandidateRecord[] = [
    ...core.map((slug) => card(slug, "core")),
    ...hot.map((slug) => card(slug, "hot")),
    ...fresh.map((slug) => card(slug, "fresh")),
    ...always.map((slug) => card(slug, "always")),
    ...finder.map(({ slug, lane, section }): PoolCandidateRecord => {
      const key = section ? sectionKey(section) : null;
      return {
        slug,
        lane,
        section_title: section?.title ?? null,
        section_key: key,
        chosen:
          key === null
            ? selected.has(slug)
            : (selected.get(slug)?.has(key) ?? false),
      };
    }),
  ];
  return {
    candidates,
    pool_size: candidates.length,
    selected_count: result.selections.length,
    selector_ran: result.selectorRan,
  };
}

/**
 * Write the turn's pool row on `raw`, its table ensured first
 * (`plugin-schema.ts`). The PK is `(conversation_id, turn)`, so a
 * re-observed turn overwrites its row, with `message_id` reset to NULL for
 * the turn-end backfill. Throws on a failed statement: `writeTurnLog` in
 * `shadow-plugin.ts` runs this inside the transaction that also replaces the
 * turn's selection rows, and owns the best-effort boundary around it.
 */
export function writePool(
  raw: MemorySqlite,
  conversationId: string,
  turn: number,
  record: PoolRecord,
): void {
  ensureMemoryV3PoolsSchemaOnce(raw);
  raw
    .query(
      /*sql*/ `
      INSERT OR REPLACE INTO memory_v3_pools (
        conversation_id, turn, message_id, created_at,
        pool_size, selected_count, selector_ran, candidates_json
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      conversationId,
      turn,
      Date.now(),
      record.pool_size,
      record.selected_count,
      record.selector_ran ? 1 : 0,
      JSON.stringify(record.candidates),
    );
}

interface PoolRow {
  turn: number;
  pool_size: number;
  selected_count: number;
  selector_ran: number;
  candidates_json: string;
}

const POOL_COLUMNS = `turn, pool_size, selected_count, selector_ran, candidates_json`;

function toStoredPool(row: PoolRow): StoredPool {
  const candidates: unknown = JSON.parse(row.candidates_json);
  if (!Array.isArray(candidates)) {
    throw new Error("candidates_json is not an array");
  }
  return {
    turn: row.turn,
    record: {
      candidates: candidates as PoolCandidateRecord[],
      pool_size: row.pool_size,
      selected_count: row.selected_count,
      selector_ran: row.selector_ran === 1,
    },
  };
}

/**
 * Best-effort read shared by the two lookups (`plugin-schema.ts`). Returns
 * `null` when the memory connection is unavailable or `select` finds no row;
 * a failed statement or an unreadable `candidates_json` logs a warning and
 * also reads as `null`, so the diagnostic can never break the inspector's
 * selection view.
 */
const readPoolOr = memoryReader(
  (context) => ensuredMemorySqlite(context, ensureMemoryV3PoolsSchemaOnce),
  (err, context) =>
    log.warn(
      { err, context },
      "failed to read memory-v3 pool; treating the turn as unrecorded",
    ),
);

function readPool(
  context: string,
  select: (raw: MemorySqlite) => PoolRow | null,
): StoredPool | null {
  return readPoolOr(context, null, (raw) => {
    const row = select(raw);
    return row ? toStoredPool(row) : null;
  });
}

/**
 * Read the pool record for an exact `(conversation, turn)`. `null` when the
 * turn has no row (it predates pool logging) or the read degraded.
 */
export function readPoolForTurn(
  conversationId: string,
  turn: number,
): PoolRecord | null {
  const stored = readPool(
    "readPoolForTurn",
    (raw) =>
      raw
        .query(
          /*sql*/ `
        SELECT ${POOL_COLUMNS} FROM memory_v3_pools
        WHERE conversation_id = ? AND turn = ?
      `,
        )
        .get(conversationId, turn) as PoolRow | null,
  );
  return stored?.record ?? null;
}

/**
 * Read the pool row stamped with one of the given message ids. The turn-end
 * backfill writes the turn's assistant message id onto its pool row, so this
 * is how the inspector finds a turn that logged no selections (the selector
 * rejected every candidate, or the gate hard-skipped it). Message ids are
 * globally unique, so no conversation scope is needed; a row that predates
 * the backfill (`message_id` NULL) never matches. `null` when no row matches
 * or the read degraded.
 */
export function readPoolForMessageIds(messageIds: string[]): StoredPool | null {
  if (messageIds.length === 0) {
    return null;
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  return readPool(
    "readPoolForMessageIds",
    (raw) =>
      raw
        .query(
          /*sql*/ `
        SELECT ${POOL_COLUMNS} FROM memory_v3_pools
        WHERE message_id IN (${placeholders})
        ORDER BY rowid
      `,
        )
        .get(...messageIds) as PoolRow | null,
  );
}
