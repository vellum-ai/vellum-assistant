/**
 * Cadence logic for thread starters generation.
 *
 * Decides whether a new generation job should be enqueued based on how many
 * active memory items have accumulated since the last generation.
 */

import { and, eq, inArray } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { rawGet } from "./raw-query.js";
import { memoryCheckpoints, memoryJobs } from "./schema.js";

const log = getLogger("thread-starters-cadence");

const CHECKPOINT_ITEM_COUNT = "thread_starters:item_count_at_last_gen";

/**
 * Check whether enough new memory items have accumulated to justify
 * generating a fresh batch of thread starters.
 */
export function maybeEnqueueThreadStartersJob(scopeId: string): void {
  const db = getDb();

  // Count total active memory items
  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );
  const totalActive = countRow?.c ?? 0;
  if (totalActive === 0) return;

  // Read checkpoint: item count at last generation
  const checkpoint = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, CHECKPOINT_ITEM_COUNT))
    .get();
  const lastCount = checkpoint ? parseInt(checkpoint.value, 10) : 0;

  // Cadence formula
  let threshold: number;
  if (totalActive <= 10) {
    threshold = 1;
  } else if (totalActive <= 50) {
    threshold = 5;
  } else {
    threshold = 10;
  }

  const delta = totalActive - lastCount;
  if (delta < threshold) return;

  // Dedup: don't enqueue if a pending/running job already exists
  const existing = db
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "generate_thread_starters"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .get();
  if (existing) return;

  enqueueMemoryJob("generate_thread_starters", { scopeId });
  log.info(
    { totalActive, lastCount, delta, threshold, scopeId },
    "Enqueued thread starters generation job",
  );
}
