import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add three nullable columns to `memory_v3_selections` for the inspector's
 * Memory V3 panel:
 *
 *   - `message_id TEXT` — the turn's assistant message id, backfilled at turn
 *     end (mirrors the v2 activation log). The inspector looks selections up by
 *     the inspected message's turn message ids, which is robust against the
 *     drift between v2's tracker turn and v3's orchestrator `turnCount` that
 *     previously left the panel blank. NULL for pre-existing rows and until the
 *     turn-end backfill stamps it.
 *   - `section_ordinal INTEGER` / `section_title TEXT` — the matched section a
 *     finder-lane selection surfaced (from `OrchestrateResult.matchedSections`).
 *     NULL for pre-existing rows and for core/hot/fresh/edge selections that
 *     carry no matched section (those render full-page, as before).
 *
 * All three are nullable and append-only — old rows degrade to the prior
 * page-level / turn-keyed behavior. The PK (conversation_id, turn, slug) is
 * unchanged; these are secondary attributes. The existing offline A/B readers
 * (`summarizeSelections`, hot-set, learned-edges, prune) ignore them.
 *
 * Idempotent — the PRAGMA guards make re-running a no-op once the columns
 * exist, and the index uses IF NOT EXISTS.
 */
export function migrateMemoryV3SelectionsMessageIdAndSections(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(memory_v3_selections)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("message_id")) {
    raw.exec(`ALTER TABLE memory_v3_selections ADD COLUMN message_id TEXT`);
  }
  if (!columnNames.has("section_ordinal")) {
    raw.exec(
      `ALTER TABLE memory_v3_selections ADD COLUMN section_ordinal INTEGER`,
    );
  }
  if (!columnNames.has("section_title")) {
    raw.exec(`ALTER TABLE memory_v3_selections ADD COLUMN section_title TEXT`);
  }

  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_v3_selections_message
       ON memory_v3_selections (message_id)`,
  );
}
