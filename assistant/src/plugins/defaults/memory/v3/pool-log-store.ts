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
 *
 * Under `memory.v3.poolLog.captureInput` (off by default) the turn's row is
 * joined by the selector's exact input, for offline selector evaluation and
 * training data: `memory_v3_pool_inputs` (one row per `(conversation,
 * turn)`: the context strings the selector was given, the selector prompt's
 * content hash, the gate reason, the keep-all flag, and the content hash of
 * every pooled candidate's rendered text in pool order, aligned with
 * `candidates_json`) and `memory_v3_pool_texts` (each rendered text once,
 * keyed by that hash). `buildPoolInput` derives both from the same
 * orchestrate result and turn as the pool record, and `writePoolInput` runs
 * in `writeTurnLog`'s transaction with the pool and selection rows. The
 * input row is purged with the conversation; the texts are page-derived and
 * content-keyed, so they are not.
 */

import { createHash } from "node:crypto";

import { getLogger } from "../logging.js";
import type { MemorySqlite } from "../memory-db.js";
import type { OrchestrateResult } from "./orchestrate.js";
import {
  ensuredMemorySqlite,
  ensureMemoryV3PoolInputsSchemaOnce,
  ensureMemoryV3PoolsSchemaOnce,
  memoryReader,
} from "./plugin-schema.js";
import { renderFinderLine } from "./pool-select.js";
import {
  type FinderLane,
  type MemoryRoutingTurn,
  sectionKey,
  type Slug,
} from "./types.js";

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

/** Content hash of a rendered candidate text or a selector prompt: the key
 *  of `memory_v3_pool_texts`. */
export function hashPoolText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The selector's exact input for one turn, persisted under
 *  `memory.v3.poolLog.captureInput` beside the turn's pool record. */
export interface PoolInputRecord {
  situational_context: string | null;
  recent_context: string;
  current_message: string;
  previous_assistant_message: string | null;
  /** Content hash of the selector system prompt the turn ran with; null
   *  when the selector was not run. */
  selector_prompt_hash: string | null;
  /** Whether the selector's recall-safe keep-all fallback fired. */
  kept_all: boolean;
  /** The injection gate's reason code; null when the gate did not run. */
  gate_reason: string | null;
  /** Content hash of each pooled candidate's rendered text, in pool order:
   *  index `i` describes the turn's pool record candidate `i`, which the
   *  selector saw under pool number `i + 1`. Empty when the record is, and
   *  when the texts could not be captured (a consumer zips by index and
   *  treats a length mismatch as texts unavailable). */
  candidate_text_hashes: string[];
}

/** A turn's input record with the rendered texts its hashes name. */
export interface PoolInputCapture {
  input: PoolInputRecord;
  texts: Map<string, string>;
}

/**
 * Build the turn's input capture from an orchestrate result and the turn it
 * ran on. Each candidate text is exactly what the selector was shown minus
 * its pool number: a stable-prefix candidate's pre-rendered card, a finder
 * candidate's rendered line ({@link renderFinderLine}), in the pool
 * record's order ({@link buildPoolRecord}). A turn whose pool record is
 * empty (the selector never judged a pool and nothing was selected)
 * captures the context strings and no candidate texts, so the hashes stay
 * aligned with that record; a result that carries no selector pool, or one
 * that disagrees with its lanes on the candidate count, captures no texts
 * either and logs the mismatch.
 */
export function buildPoolInput(
  result: OrchestrateResult,
  turn: MemoryRoutingTurn,
  selectorPrompt: string | undefined,
): PoolInputCapture {
  const texts = new Map<string, string>();
  const hashes: string[] = [];
  const recordsPool = result.selectorRan || result.selections.length > 0;
  if (recordsPool) {
    const { core, hot, fresh, always, finder } = result.lanes;
    const expected =
      core.length + hot.length + fresh.length + always.length + finder.length;
    const rendered =
      result.pool === undefined
        ? undefined
        : [
            ...result.pool.stable.map((candidate) => candidate.card),
            ...result.pool.finder.map((candidate) =>
              renderFinderLine(candidate),
            ),
          ];
    if (rendered === undefined || rendered.length !== expected) {
      log.warn(
        {
          conversationId: turn.conversationId,
          turnNumber: turn.turnNumber,
          rendered: rendered?.length ?? null,
          expected,
        },
        "memory-v3 pool input capture: the result's pool does not match its lanes; capturing no candidate texts",
      );
    } else {
      for (const text of rendered) {
        const hash = hashPoolText(text);
        hashes.push(hash);
        texts.set(hash, text);
      }
    }
  }
  return {
    input: {
      situational_context: turn.situationalContext ?? null,
      recent_context: turn.recentContext,
      current_message: turn.currentMessage,
      previous_assistant_message: turn.previousAssistantMessage ?? null,
      selector_prompt_hash:
        result.selectorRan && selectorPrompt !== undefined
          ? hashPoolText(selectorPrompt)
          : null,
      kept_all: result.keptAll ?? false,
      gate_reason: result.gateReason ?? null,
      candidate_text_hashes: hashes,
    },
    texts,
  };
}

/**
 * Write the turn's input row and its candidate texts on `raw`, their tables
 * ensured first (`plugin-schema.ts`). The row's PK is `(conversation_id,
 * turn)`, so a re-observed turn overwrites it in step with its pool row;
 * each text is inserted by hash and ignored when already stored. Throws on
 * a failed statement: `writeTurnLog` in `shadow-plugin.ts` runs this inside
 * the transaction that writes the turn's pool and selection rows, and owns
 * the best-effort boundary around it.
 */
export function writePoolInput(
  raw: MemorySqlite,
  conversationId: string,
  turn: number,
  capture: PoolInputCapture,
): void {
  ensureMemoryV3PoolInputsSchemaOnce(raw);
  const now = Date.now();
  const { input, texts } = capture;
  raw
    .query(
      /*sql*/ `
      INSERT OR REPLACE INTO memory_v3_pool_inputs (
        conversation_id, turn, created_at, situational_context, recent_context,
        current_message, previous_assistant_message, selector_prompt_hash,
        kept_all, gate_reason, candidate_text_hashes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      conversationId,
      turn,
      now,
      input.situational_context,
      input.recent_context,
      input.current_message,
      input.previous_assistant_message,
      input.selector_prompt_hash,
      input.kept_all ? 1 : 0,
      input.gate_reason,
      JSON.stringify(input.candidate_text_hashes),
    );
  const insertText = raw.query(/*sql*/ `
      INSERT OR IGNORE INTO memory_v3_pool_texts (text_hash, text, created_at)
      VALUES (?, ?, ?)
    `);
  for (const [hash, text] of texts) {
    insertText.run(hash, text, now);
  }
}

interface PoolInputRow {
  situational_context: string | null;
  recent_context: string;
  current_message: string;
  previous_assistant_message: string | null;
  selector_prompt_hash: string | null;
  kept_all: number;
  gate_reason: string | null;
  candidate_text_hashes_json: string;
}

/** Best-effort read over the capture tables, degrading to the fallback when
 *  the memory connection is unavailable or a statement fails
 *  (`plugin-schema.ts`). */
const readPoolInputOr = memoryReader(
  (context) => ensuredMemorySqlite(context, ensureMemoryV3PoolInputsSchemaOnce),
  (err, context) =>
    log.warn(
      { err, context },
      "failed to read memory-v3 pool input; treating it as unrecorded",
    ),
);

/**
 * Read the input record for an exact `(conversation, turn)`. `null` when the
 * turn has none (it ran with the capture off or predates it) or the read
 * degraded.
 */
export function readPoolInputForTurn(
  conversationId: string,
  turn: number,
): PoolInputRecord | null {
  return readPoolInputOr("readPoolInputForTurn", null, (raw) => {
    const row = raw
      .query(
        /*sql*/ `
        SELECT situational_context, recent_context, current_message,
               previous_assistant_message, selector_prompt_hash, kept_all,
               gate_reason, candidate_text_hashes_json
        FROM memory_v3_pool_inputs
        WHERE conversation_id = ? AND turn = ?
      `,
      )
      .get(conversationId, turn) as PoolInputRow | null;
    if (!row) {
      return null;
    }
    const hashes: unknown = JSON.parse(row.candidate_text_hashes_json);
    if (!Array.isArray(hashes)) {
      throw new Error("candidate_text_hashes_json is not an array");
    }
    return {
      situational_context: row.situational_context,
      recent_context: row.recent_context,
      current_message: row.current_message,
      previous_assistant_message: row.previous_assistant_message,
      selector_prompt_hash: row.selector_prompt_hash,
      kept_all: row.kept_all === 1,
      gate_reason: row.gate_reason,
      candidate_text_hashes: hashes as string[],
    };
  });
}

/** The rendered text stored under `textHash`, or `null` when none is or the
 *  read degraded. */
export function readPoolText(textHash: string): string | null {
  return readPoolInputOr("readPoolText", null, (raw) => {
    const row = raw
      .query(
        /*sql*/ `SELECT text FROM memory_v3_pool_texts WHERE text_hash = ?`,
      )
      .get(textHash) as { text: string } | null;
    return row?.text ?? null;
  });
}
