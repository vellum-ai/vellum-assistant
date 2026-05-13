// ---------------------------------------------------------------------------
// Memory retrospective — startup orphan cleanup.
// ---------------------------------------------------------------------------
//
// When the daemon crashes mid-retrospective, the bootstrapped background
// conversation lingers in the `conversations` table (and possibly the
// `messages` table) as an orphan. The jobs-store recovery
// (`resetRunningJobsToPending`) handles re-running the job, which bootstraps
// a NEW background conversation — but the previous one is never deleted
// because the original handler's cleanup path didn't get a chance to run.
//
// This module sweeps those orphans on daemon startup. Run AFTER
// `resetRunningJobsToPending` so legitimate in-flight retries (which are
// represented by their pending job row, not by a memory-retrospective
// conversation directly) aren't swept.
//
// Sweep predicate:
//   - `source = "memory-retrospective"`, AND
//   - `last_message_at < now - 1 hour` (so a freshly-running job's
//     conversation isn't swept on a startup that happens to race),
//   - AND no pending OR running `memory_retrospective` job exists. (The
//     orphan background conversation references the SOURCE conversation
//     via the wake hint; if a job exists for that source, the background
//     conversation might be the active one. We're conservative and only
//     sweep when no job exists at all, since the worst-case false-positive
//     is leaving a few extra orphans for the next sweep to catch.)

import { and, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { deleteConversation } from "./conversation-crud.js";
import { getDb } from "./db-connection.js";
import { MEMORY_RETROSPECTIVE_SOURCE } from "./memory-retrospective-constants.js";
import { conversations, memoryJobs } from "./schema.js";

const log = getLogger("memory-retrospective-startup-cleanup");

const ORPHAN_AGE_MS = 60 * 60 * 1000;

export interface CleanupResult {
  swept: number;
}

/**
 * Find and delete orphan memory-retrospective background conversations.
 * Idempotent — safe to call repeatedly. Returns the number of conversations
 * deleted. Best-effort: errors deleting individual rows are logged and the
 * sweep continues.
 */
export function sweepOrphanMemoryRetrospectiveConversations(
  now: number = Date.now(),
): CleanupResult {
  const cutoff = now - ORPHAN_AGE_MS;
  const db = getDb();

  // Job payloads encode the SOURCE conversation id (the conversation being
  // analyzed), not the background-conversation id of the retrospective itself.
  // The background conversation links back to its source via
  // `forkParentConversationId` (set when bootstrapped — see
  // memory-retrospective-job.ts). To protect in-flight jobs we therefore
  // compare source-id to source-id by filtering on
  // `conversations.forkParentConversationId`, not `conversations.id`.
  const activeJobSourceConversationIds = db
    .select({
      conversationId: sql<string>`json_extract(${memoryJobs.payload}, '$.conversationId')`,
    })
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "memory_retrospective"),
        inArray(memoryJobs.status, ["pending", "running"]),
      ),
    )
    .all()
    .map((row) => row.conversationId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const orphans = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.source, MEMORY_RETROSPECTIVE_SOURCE),
        // Conservative: only sweep rows that have had at least one message
        // AND haven't seen activity recently. Conversations without a
        // last_message_at value are too fresh to assess.
        isNotNull(conversations.lastMessageAt),
        lt(conversations.lastMessageAt, cutoff),
        activeJobSourceConversationIds.length > 0
          ? notInArray(
              conversations.forkParentConversationId,
              activeJobSourceConversationIds,
            )
          : sql`1=1`,
      ),
    )
    .all();

  let swept = 0;
  for (const row of orphans) {
    try {
      deleteConversation(row.id);
      swept++;
    } catch (err) {
      log.warn(
        { err, conversationId: row.id },
        "Failed to delete orphan memory-retrospective conversation; continuing",
      );
    }
  }
  if (swept > 0) {
    log.info(
      { swept, cutoff },
      "Swept orphan memory-retrospective background conversations",
    );
  }
  return { swept };
}
