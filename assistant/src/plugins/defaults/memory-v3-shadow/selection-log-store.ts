/**
 * Read-side store for the inspector's Memory V3 section. Reads the persisted
 * `memory_v3_selections` rows for a turn and re-renders the `<memory>` block
 * the v3 working set selected, so the inspector can show what v3 chose (and,
 * in live mode, what it actually injected) without re-running orchestration —
 * which would be wrong anyway, since the working set is stateful (carry-forward
 * across turns) and can't be reproduced after the fact.
 */

import type { MemoryV3SelectionLog } from "../../../api/responses/memory-v3-selection-log.js";
import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import { getDb, getSqliteFrom } from "../../../memory/db-connection.js";
import { renderV3SectionContent } from "./page-content.js";
import { renderMemoryBlock } from "./render-injection.js";
import {
  type Section,
  SELECTION_SOURCES,
  type SelectionSource,
  type Slug,
} from "./types.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

interface SelectionRow {
  slug: string;
  source: string;
  pinned: number;
}

function rowsForTurn(conversationId: string, turn: number): SelectionRow[] {
  return getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug, source, pinned FROM memory_v3_selections
      WHERE conversation_id = ? AND turn = ?
      ORDER BY rowid
    `,
    )
    .all(conversationId, turn) as SelectionRow[];
}

/**
 * Build the inspector's v3 selection log for one turn of a conversation.
 *
 * `turn` is the inspected message's turn (the v2-activation log's turn). The
 * selection is returned ONLY for that exact turn; when there are no v3 rows for
 * it — including when `turn` is null (the message has no v2-activation turn) —
 * this returns `null` rather than falling back to a different turn. A fallback
 * would attribute another turn's selection (e.g. a later turn's pages and
 * rendered block) to the inspected message, which corrupts shadow validation.
 *
 * Caveat: v3 rows are keyed by the orchestrator turn counter (`ctx.turnCount`)
 * while `turn` here is the v2 memory-tracker turn. They coincide for normal
 * turns, but if they diverge this simply yields `null` (no section) rather than
 * wrong data. Tying v3 rows to a message id for exact per-message attribution
 * regardless of counter drift is a documented follow-up.
 *
 * Selection rows are stored in `finalInjection` order (this turn's L2
 * selections, then carry-forward), so rendering them in row order reproduces
 * the block v3 would inject.
 */
export async function getMemoryV3SelectionForInspector(
  conversationId: string,
  turn: number | null | undefined,
): Promise<MemoryV3SelectionLog | null> {
  if (turn == null) return null;

  const rows = rowsForTurn(conversationId, turn);
  if (rows.length === 0) return null;

  const config = getConfig();
  const selections = rows.map((r) => ({
    slug: r.slug,
    source: r.source,
    pinned: r.pinned === 1,
  }));
  const slugs: Slug[] = selections.map((s) => s.slug);
  // The inspector re-renders from persisted rows without re-running
  // orchestration, so the per-slug matched section is unavailable. An empty map
  // makes `renderV3SectionContent` fall back to the full/lead page for every
  // slug — the same full-page rendering the inspector showed before
  // matched-section injection.
  const injectedText = await renderMemoryBlock(
    slugs,
    new Map<Slug, Section>(),
    renderV3SectionContent,
  );

  return {
    turn,
    live: isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config),
    shadow: isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config),
    selections,
    injectedText,
  };
}

/**
 * Offline A/B aggregate over a conversation's logged v3 selections. Reads every
 * `memory_v3_selections` row for the conversation (all turns) and rolls them up
 * for shadow-vs-v2 inspection without re-rendering any blocks:
 *
 *   - `bySource`: count of selection rows per lane source (`needle` / `dense` /
 *     `edge` / `carry-forward`). Every known source is present (zero when
 *     unused) so callers can diff two runs without null-guarding; an unknown
 *     historical/free-text source is ignored (the column is permissive).
 *   - `turns`: number of distinct turns that logged at least one selection.
 *   - `distinctSlugs`: number of distinct page slugs selected across all turns —
 *     the conversation's working-set footprint.
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
