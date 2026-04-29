/**
 * Shared checkpoint helpers for conversation starters.
 *
 * Used by both the job handler (generation) and the route handler (refresh decisions).
 */

import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { rawGet } from "./raw-query.js";
import { memoryCheckpoints } from "./schema.js";

// ── Checkpoint keys ──────────────────────────────────────────────

export const CK_ITEM_COUNT = "conversation_starters:item_count_at_last_gen";
export const CK_BATCH = "conversation_starters:generation_batch";
export const CK_LAST_GEN_AT = "conversation_starters:last_gen_at";

export function checkpointKey(base: string, scopeId: string): string {
  return `${base}:${scopeId}`;
}

export function parseCheckpointInt(value: string | undefined): number | null {
  if (value == null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export function getCheckpointValue(key: string): string | undefined {
  return getDb()
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, key))
    .get()?.value;
}

// ── Writes ───────────────────────────────────────────────────────

export function upsertCheckpoint(
  key: string,
  value: string,
  now: number = Date.now(),
): void {
  getDb()
    .insert(memoryCheckpoints)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: memoryCheckpoints.key,
      set: { value, updatedAt: now },
    })
    .run();
}

// ── Queries ──────────────────────────────────────────────────────

export function countActiveMemoryNodes(scopeId: string): number {
  return (
    rawGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM memory_graph_nodes WHERE fidelity != 'gone' AND scope_id = ?`,
      scopeId,
    )?.c ?? 0
  );
}
