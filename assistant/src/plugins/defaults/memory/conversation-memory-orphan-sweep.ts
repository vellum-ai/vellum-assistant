// ---------------------------------------------------------------------------
// Relocated memory tables — startup orphan sweep.
// ---------------------------------------------------------------------------
//
// The `conversation-deleted` / `conversations-cleared` hooks purge the
// relocated conversation-keyed memory tables when a conversation is deleted —
// but only while the memory plugin is enabled, because `runHook` filters out a
// disabled plugin's hooks. Before Wave 2 the main-DB `ON DELETE CASCADE` caught
// these deletes regardless of plugin state; once the tables live in
// `assistant-memory.db` that cross-file cascade is gone, so a conversation
// deleted while memory is disabled leaves its rows behind.
//
// This sweep runs when the memory worker next boots (i.e. when the plugin is
// active again) and deletes rows whose conversation no longer exists. In the
// common case — memory always on — the hooks already purged everything, so the
// sweep finds nothing.
//
// The memory and main databases are separate files with no cross-attach, so
// there is no single-statement anti-join: read the candidate ids from the
// memory connection, confirm existence against `conversations` on the main
// connection in batches, then delete the orphans in batches. Every read/delete
// is a bounded statement with a yield between batches, so even a large backlog
// after a long disabled window never holds the event loop.

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
  const candidates = (
    memoryRaw
      .query(`SELECT DISTINCT conversation_id AS id FROM ${table}`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  if (candidates.length === 0) {
    return 0;
  }

  // Confirm existence against the main DB in batches; ids not returned are
  // orphans whose conversation has been deleted.
  const orphans: string[] = [];
  for (let i = 0; i < candidates.length; i += SWEEP_BATCH) {
    const batch = candidates.slice(i, i + SWEEP_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const alive = new Set(
      (
        mainRaw
          .query(`SELECT id FROM conversations WHERE id IN (${placeholders})`)
          .all(...batch) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    for (const id of batch) {
      if (!alive.has(id)) {
        orphans.push(id);
      }
    }
    await breathe();
  }

  // Delete the orphan rows in batches, yielding between each so a large
  // backlog does not hold the write lock or the event loop.
  let deleted = 0;
  for (let i = 0; i < orphans.length; i += SWEEP_BATCH) {
    const batch = orphans.slice(i, i + SWEEP_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    memoryRaw
      .query(`DELETE FROM ${table} WHERE conversation_id IN (${placeholders})`)
      .run(...batch);
    deleted += batch.length;
    await breathe();
  }
  return deleted;
}
