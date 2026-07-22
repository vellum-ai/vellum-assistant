// ---------------------------------------------------------------------------
// Relocated memory tables — startup orphan sweep.
// ---------------------------------------------------------------------------
//
// The `conversation-deleted` hook purges the relocated conversation-keyed
// memory tables when a single conversation is deleted (and the prune job fires
// the same hook per pruned id) — but only while the memory plugin is enabled,
// because `runHook` filters out a disabled plugin's hooks. Before Wave 2 the
// main-DB `ON DELETE CASCADE` caught these deletes regardless of plugin state;
// once the tables live in `assistant-memory.db` that cross-file cascade is
// gone, so a conversation deleted while memory is disabled leaves its rows
// behind. (Clear-all is unaffected — the daemon wipes these tables directly,
// unconditionally.)
//
// This sweep runs when the memory worker next boots (i.e. when the plugin is
// active again) and deletes rows whose conversation no longer exists. In the
// common case — memory always on — the hook already purged everything, so the
// sweep finds nothing.
//
// The memory and main databases are separate files with no cross-attach, so
// there is no single-statement anti-join: page distinct conversation ids off
// the memory connection by keyset, confirm existence against `conversations`
// on the main connection, then delete that page's orphans. Every read/delete
// is a bounded statement with a yield between pages, so even a large backlog
// after a long disabled window never materializes all ids at once or holds the
// event loop.

import { getSqlite } from "../../../persistence/db-connection.js";
import { CONVERSATION_KEYED_MEMORY_TABLES } from "./conversation-memory-purge.js";
import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("conversation-memory-orphan-sweep");

/** Ids per batched `IN (...)` probe/delete — bounds each statement's lock. */
const SWEEP_BATCH = 500;

export interface OrphanSweepResult {
  /** Total orphan rows deleted across every relocated table. */
  swept: number;
}

/** Yield to the event loop so a large backlog never blocks it. */
function breathe(): Promise<void> {
  return Bun.sleep(0);
}

/**
 * Delete rows whose conversation no longer exists from every relocated
 * conversation-keyed memory table. Idempotent and best-effort: a null memory
 * connection no-ops, and a single failing table is logged and skipped so the
 * rest still run.
 */
export async function sweepOrphanConversationMemoryTables(): Promise<OrphanSweepResult> {
  const memoryRaw = memorySqliteOrNull("sweepOrphanConversationMemoryTables");
  if (!memoryRaw) {
    return { swept: 0 };
  }
  const mainRaw = getSqlite();

  let swept = 0;
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      swept += await sweepTable(table, memoryRaw, mainRaw);
    } catch (err) {
      log.warn(
        { err, table },
        "Failed to sweep orphan rows from a relocated memory table; continuing",
      );
    }
  }
  if (swept > 0) {
    log.info({ swept }, "Swept orphan rows from relocated memory tables");
  }
  return { swept };
}

async function sweepTable(
  table: string,
  memoryRaw: NonNullable<ReturnType<typeof memorySqliteOrNull>>,
  mainRaw: ReturnType<typeof getSqlite>,
): Promise<number> {
  let deleted = 0;
  // Keyset cursor over distinct conversation ids. The empty string sorts before
  // any real id, so the first page starts at the beginning.
  let cursor = "";
  for (;;) {
    // One bounded page of distinct ids, resuming past the cursor so the scan
    // advances through the index instead of restarting from the top each round
    // (which would re-scan the whole table per batch). Only this page's ids are
    // ever held in memory.
    const page = (
      memoryRaw
        .query(
          `SELECT DISTINCT conversation_id AS id FROM ${table}
           WHERE conversation_id > ? ORDER BY conversation_id LIMIT ?`,
        )
        .all(cursor, SWEEP_BATCH) as Array<{ id: string }>
    ).map((row) => row.id);
    if (page.length === 0) {
      break;
    }
    cursor = page[page.length - 1]!;

    // Confirm existence against the main DB; ids not returned are orphans whose
    // conversation has been deleted.
    const placeholders = page.map(() => "?").join(", ");
    const alive = new Set(
      (
        mainRaw
          .query(`SELECT id FROM conversations WHERE id IN (${placeholders})`)
          .all(...page) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const orphans = page.filter((id) => !alive.has(id));
    if (orphans.length > 0) {
      const del = orphans.map(() => "?").join(", ");
      memoryRaw
        .query(`DELETE FROM ${table} WHERE conversation_id IN (${del})`)
        .run(...orphans);
      deleted += orphans.length;
    }

    await breathe();
    if (page.length < SWEEP_BATCH) {
      break;
    }
  }
  return deleted;
}
