/**
 * Cadence logic for conversation starters and capability cards generation.
 *
 * Decides whether new generation jobs should be enqueued based on how many
 * active memory items have accumulated since the last generation.
 */

import { and, eq, inArray, like } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { CAPABILITY_CARD_CATEGORIES } from "./job-handlers/capability-cards.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { rawGet } from "./raw-query.js";
import { memoryCheckpoints, memoryJobs } from "./schema.js";

const log = getLogger("conversation-starters-cadence");

/**
 * Check whether enough new memory items have accumulated to justify
 * generating a fresh batch of conversation starters and capability cards.
 */
export function maybeEnqueueConversationStartersJob(scopeId: string): void {
  const db = getDb();

  // Count total active memory items
  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );
  const totalActive = countRow?.c ?? 0;
  if (totalActive === 0) return;

  // Read checkpoint: item count at last generation (scoped so each scope tracks independently)
  const checkpointKey = `conversation_starters:item_count_at_last_gen:${scopeId}`;
  const checkpoint = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, checkpointKey))
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

  // Dedup: don't enqueue if a pending/running job for this scope already exists
  const existing = db
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "generate_conversation_starters"),
        inArray(memoryJobs.status, ["pending", "running"]),
        like(memoryJobs.payload, `%"scopeId":"${scopeId}"%`),
      ),
    )
    .get();
  if (existing) return;

  enqueueMemoryJob("generate_conversation_starters", { scopeId });
  log.info(
    { totalActive, lastCount, delta, threshold, scopeId },
    "Enqueued conversation starters generation job",
  );

  // Also enqueue capability card regeneration for all categories
  maybeEnqueueCapabilityCardJobs(scopeId);
}

/**
 * Enqueue capability card generation jobs for all categories.
 * Skips categories that already have pending/running jobs.
 */
function maybeEnqueueCapabilityCardJobs(scopeId: string): void {
  const db = getDb();

  for (const category of CAPABILITY_CARD_CATEGORIES) {
    const existing = db
      .select({ id: memoryJobs.id })
      .from(memoryJobs)
      .where(
        and(
          eq(memoryJobs.type, "generate_capability_cards"),
          inArray(memoryJobs.status, ["pending", "running"]),
          like(memoryJobs.payload, `%"scopeId":"${scopeId}"%`),
          like(memoryJobs.payload, `%"category":"${category}"%`),
        ),
      )
      .get();

    if (!existing) {
      enqueueMemoryJob("generate_capability_cards", { scopeId, category });
    }
  }

  log.info({ scopeId }, "Enqueued capability card generation jobs");
}
