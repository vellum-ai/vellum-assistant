/**
 * Read-side store for the inspector's Memory V3 section. Reads the persisted
 * `memory_v3_selections` rows for a turn and re-renders the `<memory>` block
 * the v3 working set selected, so the inspector can show what v3 chose (and,
 * in live mode, what it actually injected) without re-running orchestration —
 * which would be wrong anyway, since the working set is stateful (carry-forward
 * across turns) and can't be reproduced after the fact.
 */

import type { MemoryV3SelectionLog } from "../../api/responses/memory-v3-selection-log.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getDb, getSqliteFrom } from "../db-connection.js";
import { renderV3PageContent } from "./page-content.js";
import { renderMemoryBlock } from "./render-injection.js";
import type { Slug } from "./types.js";

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

function latestTurn(conversationId: string): number | null {
  const row = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT MAX(turn) AS t FROM memory_v3_selections WHERE conversation_id = ?
    `,
    )
    .get(conversationId) as { t: number | null } | undefined;
  return row?.t ?? null;
}

/**
 * Build the inspector's v3 selection log for a conversation.
 *
 * `preferredTurn` (the v2-activation log's turn, when the caller has one) is
 * tried first. The v3 turn counter (`ctx.turnCount`) and the v2 memory-tracker
 * turn need not agree, so when the preferred turn has no v3 rows we fall back
 * to the conversation's most-recent v3 turn rather than guessing an alignment.
 * Returns `null` when the conversation has no v3 selections at all (v3 never
 * ran for it).
 *
 * Selection rows are stored in `finalInjection` order (this turn's L2
 * selections, then carry-forward), so rendering them in row order reproduces
 * the block v3 would inject.
 */
export async function getMemoryV3SelectionForInspector(
  conversationId: string,
  preferredTurn?: number | null,
): Promise<MemoryV3SelectionLog | null> {
  let turn: number | null = null;
  let rows: SelectionRow[] = [];

  if (preferredTurn != null) {
    const preferred = rowsForTurn(conversationId, preferredTurn);
    if (preferred.length > 0) {
      turn = preferredTurn;
      rows = preferred;
    }
  }

  if (turn == null) {
    const latest = latestTurn(conversationId);
    if (latest == null) return null;
    turn = latest;
    rows = rowsForTurn(conversationId, latest);
  }

  if (rows.length === 0) return null;

  const config = getConfig();
  const selections = rows.map((r) => ({
    slug: r.slug,
    source: r.source,
    pinned: r.pinned === 1,
  }));
  const slugs: Slug[] = selections.map((s) => s.slug);
  const injectedText = await renderMemoryBlock(slugs, renderV3PageContent);

  return {
    turn,
    live: isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config),
    shadow: isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config),
    selections,
    injectedText,
  };
}
