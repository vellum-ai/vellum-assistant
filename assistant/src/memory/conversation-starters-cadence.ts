/**
 * Cadence logic for conversation starters generation.
 *
 * Decides whether a new generation job should be enqueued based on how many
 * active memory items have accumulated since the last generation.
 */

import { and, eq, inArray, like } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import {
  CK_CONVERSATION_STARTERS_ITEM_COUNT,
  CK_CONVERSATION_STARTERS_LAST_ATTEMPT_AT,
  CK_CONVERSATION_STARTERS_LAST_GEN_AT,
  CONVERSATION_STARTERS_ATTEMPT_COOLDOWN_MS,
  CONVERSATION_STARTERS_MIN_REGEN_INTERVAL_MS,
  conversationStartersCheckpointKey,
  conversationStartersGenerationThreshold,
} from "./conversation-starters-policy.js";
import { getDb } from "./db.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { rawGet } from "./raw-query.js";
import { memoryCheckpoints, memoryJobs } from "./schema.js";

const log = getLogger("conversation-starters-cadence");

function readCheckpointInt(scopeId: string, baseKey: string): number {
  const db = getDb();
  const checkpoint = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(
      eq(
        memoryCheckpoints.key,
        conversationStartersCheckpointKey(baseKey, scopeId),
      ),
    )
    .get();
  return checkpoint ? parseInt(checkpoint.value, 10) : 0;
}

export function hasRecentConversationStarterAttempt(
  scopeId: string,
  nowMs = Date.now(),
): boolean {
  const lastAttemptAt = readCheckpointInt(
    scopeId,
    CK_CONVERSATION_STARTERS_LAST_ATTEMPT_AT,
  );
  return (
    lastAttemptAt > 0 &&
    nowMs - lastAttemptAt < CONVERSATION_STARTERS_ATTEMPT_COOLDOWN_MS
  );
}

/**
 * Check whether enough new memory items have accumulated to justify
 * generating a fresh batch of conversation starters.
 */
export function maybeEnqueueConversationStartersJob(
  scopeId: string,
  nowMs = Date.now(),
): void {
  const db = getDb();

  // Count total active memory items
  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );
  const totalActive = countRow?.c ?? 0;
  if (totalActive === 0) return;

  if (hasRecentConversationStarterAttempt(scopeId, nowMs)) return;

  const lastGenAt = readCheckpointInt(
    scopeId,
    CK_CONVERSATION_STARTERS_LAST_GEN_AT,
  );
  if (
    lastGenAt > 0 &&
    nowMs - lastGenAt < CONVERSATION_STARTERS_MIN_REGEN_INTERVAL_MS
  ) {
    return;
  }

  const lastCount = readCheckpointInt(
    scopeId,
    CK_CONVERSATION_STARTERS_ITEM_COUNT,
  );
  const threshold = conversationStartersGenerationThreshold(totalActive);

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
}
