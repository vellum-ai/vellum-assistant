/**
 * Read-side store for the inspector's Memory V3 panel. Reads the persisted
 * `memory_v3_selections` rows for a turn (by the turn's message ids) and
 * re-renders the `<memory>` block for what v3 selected, so the inspector can
 * show the turn's selection without re-running orchestration — which would be
 * wrong anyway, since the hot lane is frecency-stateful and can't be reproduced
 * after the fact.
 *
 * The rendered text is inspector-only and NOT byte-identical to live injection:
 * the live injector freezes net-new compact CARDS into history
 * (`renderV3CardContent`) plus an ephemeral spotlight. Here we re-render each
 * selection's MATCHED SECTION — resolved from the persisted `(slug, ordinal)`
 * against the current page — when one was recorded, falling back to the
 * full/lead page otherwise. Section text is re-derived from the current page,
 * so it reflects bounded page-drift if the page changed since the turn (the
 * same approximation the v2 inspector accepts).
 */

import type { MemoryV3SelectionLog } from "../../../../api/responses/memory-v3-selection-log.js";
import { getConfig } from "../../../../config/loader.js";
import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import { getDb, getSqliteFrom } from "../../../../persistence/db-connection.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { readPage } from "../v2/page-store.js";
import { capabilityOrDiskBody } from "./capabilities.js";
import { sectionByOrdinal } from "./orchestrate.js";
import { renderV3SectionContent } from "./page-content.js";
import { renderMemoryBlock } from "./render-injection.js";
import { buildSectionIndex } from "./sections.js";
import {
  type Section,
  SELECTION_SOURCES,
  type SelectionSource,
  type Slug,
} from "./types.js";

interface SelectionRow {
  turn: number;
  slug: string;
  source: string;
  pinned: number;
  section_ordinal: number | null;
  section_title: string | null;
}

const SELECTION_COLUMNS = `turn, slug, source, pinned, section_ordinal, section_title`;

function rowsForTurn(conversationId: string, turn: number): SelectionRow[] {
  return getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT ${SELECTION_COLUMNS} FROM memory_v3_selections
      WHERE conversation_id = ? AND turn = ?
      ORDER BY rowid
    `,
    )
    .all(conversationId, turn) as SelectionRow[];
}

function rowsForMessageIds(messageIds: string[]): SelectionRow[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  return getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT ${SELECTION_COLUMNS} FROM memory_v3_selections
      WHERE message_id IN (${placeholders})
      ORDER BY rowid
    `,
    )
    .all(...messageIds) as SelectionRow[];
}

const MAX_FORK_HOPS = 64;

/**
 * Read the `forkSourceMessageId` back-pointer that `cloneForkMessageMetadata`
 * stamps onto every message a fork copies, for the given message ids.
 */
function forkSourceIdsOf(messageIds: string[]): string[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT json_extract(metadata, '$.forkSourceMessageId') AS src
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
 * `memory_v3_selections` rows, so an inherited turn has no rows under its own
 * message ids. Each copied message preserves a `forkSourceMessageId` pointer to
 * the message it was cloned from; walk that chain (a fork of a fork chains it
 * again) to the nearest ancestor generation that logged selections and return
 * those rows. Returns `[]` when no ancestor has v3 rows (or the ids aren't fork
 * copies).
 */
function rowsViaForkSource(messageIds: string[]): SelectionRow[] {
  let frontier = messageIds;
  const visited = new Set(messageIds);
  for (let hop = 0; hop < MAX_FORK_HOPS; hop++) {
    const sources = forkSourceIdsOf(frontier).filter((id) => !visited.has(id));
    if (sources.length === 0) return [];
    for (const id of sources) visited.add(id);
    const rows = rowsForMessageIds(sources);
    if (rows.length > 0) return rows;
    frontier = sources;
  }
  return [];
}

/**
 * Resolve each selection's persisted matched section `(slug, ordinal)` to the
 * concrete `Section` in the CURRENT page, so the injected block renders the
 * matched section rather than the full page. Only slugs with a recorded ordinal
 * are resolved (core/hot/fresh/edge selections have none and render full-page).
 * A page edited since the turn re-derives the current section at that ordinal,
 * or falls back to full-page when the ordinal no longer exists.
 */
async function reconstructMatchedSections(
  rows: SelectionRow[],
): Promise<Map<Slug, Section>> {
  const sectionSlugs = rows
    .filter((r) => r.section_ordinal != null)
    .map((r) => r.slug);
  if (sectionSlugs.length === 0) return new Map();

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
    if (row.section_ordinal == null) continue;
    const section = sectionByOrdinal(index, row.slug, row.section_ordinal);
    if (section) sectionBySlug.set(row.slug, section);
  }
  return sectionBySlug;
}

async function buildSelectionLog(
  rows: SelectionRow[],
): Promise<MemoryV3SelectionLog | null> {
  if (rows.length === 0) return null;

  const config = getConfig();
  const selections = rows.map((r) => ({
    slug: r.slug,
    source: r.source,
    pinned: r.pinned === 1,
    sectionOrdinal: r.section_ordinal,
    sectionHeading: r.section_title,
  }));
  const slugs: Slug[] = selections.map((s) => s.slug);
  const sectionBySlug = await reconstructMatchedSections(rows);
  const injectedText = await renderMemoryBlock(
    slugs,
    sectionBySlug,
    renderV3SectionContent,
  );

  return {
    turn: rows[0]!.turn,
    live: isMemoryV3Live(config),
    selections,
    injectedText,
  };
}

/**
 * Build the inspector's v3 selection log for the inspected message's turn,
 * keyed by the turn's message ids. This is the durable join: `writeSelections`
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
 * Selection rows are stored in selection order, so rendering them in row order
 * reproduces the block v3 would inject.
 */
export async function getMemoryV3SelectionForInspectorByMessageIds(
  messageIds: string[],
): Promise<MemoryV3SelectionLog | null> {
  const rows = rowsForMessageIds(messageIds);
  return buildSelectionLog(
    rows.length > 0 ? rows : rowsViaForkSource(messageIds),
  );
}

/**
 * Turn-keyed variant, retained for callers/tests that look up by an exact
 * `(conversation, turn)`. Returns `null` when `turn` is null or there are no
 * rows for it.
 */
export async function getMemoryV3SelectionForInspector(
  conversationId: string,
  turn: number | null | undefined,
): Promise<MemoryV3SelectionLog | null> {
  if (turn == null) return null;
  return buildSelectionLog(rowsForTurn(conversationId, turn));
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
  const rows = getSqliteFrom(getDb())
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
  }>;

  const bySource = Object.fromEntries(
    SELECTION_SOURCES.map((source) => [source, 0]),
  ) as Record<SelectionSource, number>;
  const turns = new Set<number>();
  const slugs = new Set<string>();
  for (const row of rows) {
    if (isSelectionSource(row.source)) bySource[row.source] += 1;
    turns.add(row.turn);
    slugs.add(row.slug);
  }

  return { bySource, turns: turns.size, distinctSlugs: slugs.size };
}
