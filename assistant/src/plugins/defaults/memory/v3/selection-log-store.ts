/**
 * Read-side store for the inspector's Memory V3 panel. Reads the persisted
 * `memory_v3_selections` rows for a turn (by the turn's message ids) and
 * re-renders the `<memory>` block for what v3 selected, so the inspector can
 * show the turn's selection without re-running orchestration — which would be
 * wrong anyway, since the hot lane is frecency-stateful and can't be reproduced
 * after the fact.
 *
 * The rendered text is inspector-only and NOT byte-identical to live injection:
 * the live injector freezes only the turn's NET-NEW sections into history and
 * points at the rest. Here we re-render EVERY selection with the injector's
 * own entry renderer (`renderV3InjectionEntry`): the MATCHED SECTION resolved
 * from the persisted `(slug, ordinal)` against the current page when one was
 * recorded, the page's lead otherwise. Section text is re-derived from the
 * current page, so it reflects bounded page-drift if the page changed since
 * the turn (the same approximation the v2 inspector accepts).
 *
 * The log also carries the turn's candidate `pool` (`memory_v3_pools`, read by
 * the resolved rows' `(conversation, turn)` so it is always the same turn as
 * the selections), or `null` for turns that predate pool logging. A turn that
 * logged no selections (the selector rejected every candidate, or the
 * injection gate hard-skipped it) has no rows to resolve through, so it is
 * found by its pool row's stamped message id instead and rendered as an empty
 * selection with the pool: the negative verdict is part of the audit.
 */

import type { MemoryV3SelectionLog } from "../../../../api/responses/memory-v3-selection-log.js";
import { getConfig } from "../../../../config/loader.js";
import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import { getDb, getSqliteFrom } from "../../../../persistence/db-connection.js";
import { memorySqliteOrNull } from "../memory-db.js";
import { wrapMemoryBlock } from "../memory-marker.js";
import { getWorkspaceDir } from "../paths.js";
import { readPage } from "../substrate/page-store.js";
import { capabilityOrDiskBody } from "./capabilities.js";
import { sectionByOrdinal } from "./orchestrate.js";
import { renderV3InjectionEntry } from "./page-content.js";
import {
  type PoolRecord,
  readPoolForMessageIds,
  readPoolForTurn,
} from "./pool-log-store.js";
import { renderInjectionBlockInner } from "./render-injection.js";
import { buildSectionIndex } from "./sections.js";
import {
  type Section,
  SELECTION_SOURCES,
  type SelectionSource,
  type Slug,
} from "./types.js";

interface SelectionRow {
  conversation_id: string;
  turn: number;
  slug: string;
  source: string;
  section_ordinal: number | null;
  section_title: string | null;
}

const SELECTION_COLUMNS = `conversation_id, turn, slug, source, section_ordinal, section_title`;

function rowsForTurn(conversationId: string, turn: number): SelectionRow[] {
  const raw = memorySqliteOrNull("rowsForTurn");
  if (!raw) {
    return [];
  }
  return raw
    .query(
      /*sql*/ `
      SELECT ${SELECTION_COLUMNS} FROM memory_v3_selections
      WHERE conversation_id = ? AND turn = ?
      ORDER BY rowid
    `,
    )
    .all(conversationId, turn) as SelectionRow[];
}

/** The selection rows stamped with any of the given message ids, or `null`
 *  when there are none (including when the memory connection is unavailable). */
function rowsForMessageIds(messageIds: string[]): SelectionRow[] | null {
  if (messageIds.length === 0) {
    return null;
  }
  const raw = memorySqliteOrNull("rowsForMessageIds");
  if (!raw) {
    return null;
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = raw
    .query(
      /*sql*/ `
      SELECT ${SELECTION_COLUMNS} FROM memory_v3_selections
      WHERE message_id IN (${placeholders})
      ORDER BY rowid
    `,
    )
    .all(...messageIds) as SelectionRow[];
  return rows.length > 0 ? rows : null;
}

const MAX_FORK_HOPS = 64;

/**
 * Read the `forkSourceMessageId` back-pointer that `cloneForkMessageMetadata`
 * stamps onto every message a fork copies, for the given message ids.
 */
function forkSourceIdsOf(messageIds: string[]): string[] {
  if (messageIds.length === 0) {
    return [];
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT json_extract(metadata, '$.forkSourceMessageId') AS src
      -- No completeness predicate: ids come from this store's own selection
      -- log, written for rows the injection pipeline already processed.
      FROM messages
      WHERE id IN (${placeholders})
    `,
    )
    .all(...messageIds) as Array<{ src: string | null }>;
  return rows
    .map((r) => r.src)
    .filter((src): src is string => typeof src === "string" && src.length > 0);
}

/**
 * A fork copies the parent's messages under fresh ids but does not copy their
 * `memory_v3_selections` or `memory_v3_pools` rows, so an inherited turn has
 * nothing under its own message ids. Each copied message preserves a
 * `forkSourceMessageId` pointer to the message it was cloned from; walk that
 * chain (a fork of a fork chains it again) to the nearest ancestor generation
 * where `lookup` finds something and return it. Returns `null` when no
 * ancestor has a match (or the ids aren't fork copies).
 */
function viaForkSource<T>(
  messageIds: string[],
  lookup: (messageIds: string[]) => T | null,
): T | null {
  let frontier = messageIds;
  const visited = new Set(messageIds);
  for (let hop = 0; hop < MAX_FORK_HOPS; hop++) {
    const sources = forkSourceIdsOf(frontier).filter((id) => !visited.has(id));
    if (sources.length === 0) {
      return null;
    }
    for (const id of sources) {
      visited.add(id);
    }
    const found = lookup(sources);
    if (found !== null) {
      return found;
    }
    frontier = sources;
  }
  return null;
}

/**
 * The current section a persisted selection row names. The recorded title
 * is the identity: chunk counts and ordinals shift whenever a page is edited
 * or the chunker changes, so a row resolves to the current section carrying
 * its `section_title`, the recorded ordinal only choosing among repeated
 * headings or chunks of that title when it still points at one of them and
 * the first occurrence otherwise. A title no longer on the page resolves to
 * nothing (the lead renders instead). Rows recorded without a title (older
 * rows) fall back to the ordinal alone.
 */
function resolveRecordedSection(
  index: Awaited<ReturnType<typeof buildSectionIndex>>,
  row: SelectionRow,
): Section | undefined {
  if (row.section_title === null) {
    return row.section_ordinal === null
      ? undefined
      : sectionByOrdinal(index, row.slug, row.section_ordinal);
  }
  const titled = (index.byArticle.get(row.slug) ?? [])
    .map((i) => index.sections[i]!)
    .filter((section) => section.title === row.section_title);
  return (
    titled.find((section) => section.ordinal === row.section_ordinal) ??
    titled[0]
  );
}

/**
 * Resolve each selection's persisted matched section to the concrete
 * `Section` in the CURRENT page (see {@link resolveRecordedSection}), so the
 * injected block renders the matched section rather than the lead. Only rows
 * that recorded a section (a title or an ordinal) are resolved; core, hot,
 * fresh, and edge selections record none and render the lead.
 */
async function reconstructMatchedSections(
  rows: SelectionRow[],
): Promise<Map<Slug, Section>> {
  const sectionSlugs = rows
    .filter((r) => r.section_ordinal != null || r.section_title != null)
    .map((r) => r.slug);
  if (sectionSlugs.length === 0) {
    return new Map();
  }

  const workspaceDir = getWorkspaceDir();
  const pageBody = (slug: Slug): Promise<string> =>
    capabilityOrDiskBody(slug, async (s) => {
      try {
        return (await readPage(workspaceDir, s))?.body ?? "";
      } catch {
        return "";
      }
    });
  const index = await buildSectionIndex(sectionSlugs, pageBody);

  const sectionBySlug = new Map<Slug, Section>();
  for (const row of rows) {
    const section = resolveRecordedSection(index, row);
    if (section) {
      sectionBySlug.set(row.slug, section);
    }
  }
  return sectionBySlug;
}

/**
 * Map a persisted pool record onto the inspector wire shape. `null` when the
 * turn has no pool row (it predates pool logging) or the memory connection is
 * unavailable.
 */
function toInspectorPool(
  record: PoolRecord | null,
): MemoryV3SelectionLog["pool"] {
  if (!record) {
    return null;
  }
  return {
    poolSize: record.pool_size,
    selectedCount: record.selected_count,
    selectorRan: record.selector_ran,
    candidates: record.candidates.map((candidate) => ({
      slug: candidate.slug,
      lane: candidate.lane,
      sectionHeading: candidate.section_title,
      chosen: candidate.chosen,
    })),
  };
}

/**
 * The log for a turn that persisted a pool but no selections: the selector
 * rejected every candidate, or the injection gate hard-skipped it. Nothing was
 * injected, so the block is empty; the pool carries the verdict.
 */
function poolOnlyLog(turn: number, record: PoolRecord): MemoryV3SelectionLog {
  return {
    turn,
    live: isMemoryV3Live(getConfig()),
    selections: [],
    injectedText: "",
    pool: toInspectorPool(record),
  };
}

async function buildSelectionLog(
  rows: SelectionRow[],
): Promise<MemoryV3SelectionLog | null> {
  const first = rows[0];
  if (!first) {
    return null;
  }

  const config = getConfig();
  const selections = rows.map((r) => ({
    slug: r.slug,
    source: r.source,
    sectionOrdinal: r.section_ordinal,
    sectionHeading: r.section_title,
  }));
  const slugs: Slug[] = selections.map((s) => s.slug);
  const sectionBySlug = await reconstructMatchedSections(rows);
  // Each entry is an independent page read; the rendered block keeps `slugs`
  // order regardless of which resolves first.
  const entries = (
    await Promise.all(
      slugs.map((slug) =>
        renderV3InjectionEntry(slug, sectionBySlug.get(slug)),
      ),
    )
  ).filter((entry) => entry.length > 0);
  const inner = renderInjectionBlockInner(entries);
  const injectedText = inner.length === 0 ? "" : wrapMemoryBlock(inner);

  return {
    turn: first.turn,
    live: isMemoryV3Live(config),
    selections,
    injectedText,
    pool: toInspectorPool(readPoolForTurn(first.conversation_id, first.turn)),
  };
}

/**
 * Build the inspector's v3 selection log for the inspected message's turn,
 * keyed by the turn's message ids. This is the durable join: `writeTurnLog`
 * logs rows with `message_id = NULL` and the turn-end backfill stamps them with
 * the assistant message id, so a per-message lookup is robust against the drift
 * between v2's tracker turn and v3's orchestrator `turnCount`. Returns `null`
 * when no v3 rows match (e.g. a turn predating the message-id backfill, or a
 * conversation with no v3 data). Message ids are globally unique, so no
 * conversation scope is needed.
 *
 * For turns inherited from a fork, the copied messages carry fresh ids with no
 * selection rows of their own, so the lookup falls back to the parent's rows by
 * following each message's `forkSourceMessageId` back-pointer.
 *
 * A turn with no selection rows anywhere may still have a pool row (its
 * message id is stamped by the same backfill): the selector rejected every
 * candidate, or the gate hard-skipped it. That turn resolves through the pool,
 * with the same fork walk, to a log with empty selections.
 *
 * Selection rows are stored in selection order, so rendering them in row order
 * reproduces the block v3 would inject.
 */
export async function getMemoryV3SelectionForInspectorByMessageIds(
  messageIds: string[],
): Promise<MemoryV3SelectionLog | null> {
  const rows =
    rowsForMessageIds(messageIds) ??
    viaForkSource(messageIds, rowsForMessageIds);
  if (rows) {
    return buildSelectionLog(rows);
  }
  const pool =
    readPoolForMessageIds(messageIds) ??
    viaForkSource(messageIds, readPoolForMessageIds);
  return pool ? poolOnlyLog(pool.turn, pool.record) : null;
}

/**
 * Turn-keyed variant, retained for callers/tests that look up by an exact
 * `(conversation, turn)`. Resolves a pool-only turn the same way as the
 * message-id path. Returns `null` when `turn` is null or nothing was logged
 * for it.
 */
export async function getMemoryV3SelectionForInspector(
  conversationId: string,
  turn: number | null | undefined,
): Promise<MemoryV3SelectionLog | null> {
  if (turn == null) {
    return null;
  }
  const rows = rowsForTurn(conversationId, turn);
  if (rows.length > 0) {
    return buildSelectionLog(rows);
  }
  const pool = readPoolForTurn(conversationId, turn);
  return pool ? poolOnlyLog(turn, pool) : null;
}

/**
 * Offline A/B aggregate over a conversation's logged v3 selections. Reads every
 * `memory_v3_selections` row for the conversation (all turns) and rolls them up
 * for shadow-vs-v2 inspection without re-rendering any blocks:
 *
 *   - `bySource`: count of selection rows per lane source (`core` / `hot` /
 *     `needle` / `dense` / `edge`). Every known source is present (zero when
 *     unused) so callers can diff two runs without null-guarding; an unknown
 *     historical/free-text source — including retired labels like the old
 *     per-turn carry source — is ignored (the column is permissive).
 *   - `turns`: number of distinct turns that logged at least one selection.
 *   - `distinctSlugs`: number of distinct page slugs selected across all turns —
 *     the conversation's selection footprint.
 *
 * This is read-only telemetry for comparing a shadow run's lane mix against
 * v2's logged selections offline; it never re-runs orchestration.
 */
export interface SelectionSummary {
  bySource: Record<SelectionSource, number>;
  turns: number;
  distinctSlugs: number;
}

function isSelectionSource(source: string): source is SelectionSource {
  return (SELECTION_SOURCES as readonly string[]).includes(source);
}

export function summarizeSelections(conversationId: string): SelectionSummary {
  const raw = memorySqliteOrNull("summarizeSelections");
  const rows = raw
    ? (raw
        .query(
          /*sql*/ `
      SELECT turn, slug, source FROM memory_v3_selections
      WHERE conversation_id = ?
    `,
        )
        .all(conversationId) as Array<{
        turn: number;
        slug: string;
        source: string;
      }>)
    : [];

  const bySource = Object.fromEntries(
    SELECTION_SOURCES.map((source) => [source, 0]),
  ) as Record<SelectionSource, number>;
  const turns = new Set<number>();
  const slugs = new Set<string>();
  for (const row of rows) {
    if (isSelectionSource(row.source)) {
      bySource[row.source] += 1;
    }
    turns.add(row.turn);
    slugs.add(row.slug);
  }

  return { bySource, turns: turns.size, distinctSlugs: slugs.size };
}
