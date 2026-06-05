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
  const injectedText = await renderMemoryBlock(slugs, renderV3PageContent);

  return {
    turn,
    live: isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config),
    shadow: isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config),
    selections,
    injectedText,
  };
}
