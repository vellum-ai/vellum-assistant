import { and, asc, eq, gt, or } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import {
  deleteMemoryCheckpoint,
  isLexicalBackfillComplete,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  setMemoryCheckpoint,
  writeMessageCursorCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import { withQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";
import { getLogger } from "../../../../util/logger.js";
import {
  isMemoryIndexingSuppressed,
  resolveLexicalIndex,
} from "./index-message-lexical.js";

const log = getLogger("lexical-backfill");

/**
 * Cursor checkpoint keys for the lexical-index backfill. Kept distinct from the
 * dense embedding backfill's keys (`memory:backfill:*`) so the two backfills
 * advance independently — enabling lexical without re-running the dense one, and
 * vice versa.
 */
const LEXICAL_BACKFILL_CHECKPOINT_KEY = "lexical:messages:last_created_at";
const LEXICAL_BACKFILL_CHECKPOINT_ID_KEY = "lexical:messages:last_id";

/**
 * One-time, self-healing auto-enqueue of the messages lexical-index backfill,
 * invoked once from `runMemoryStartup` (startup.ts) on daemon boot. Ensures each
 * instance populates its Qdrant lexical index (`messages_lexical`) exactly once
 * on upgrade — in the background — so a later read-path flip to the lexical
 * backend does not open onto an empty index.
 *
 * Deliberate, narrow exception to the "not run at daemon startup" note carried by
 * the manual backfill route (`messages-lexical-routes.ts`, added in the FTS→Qdrant
 * PR 5): this call only *enqueues* a memory job — it does no indexing, no LLM
 * work, and no other heavy lifting on the boot thread. The backfill itself runs
 * off the event loop via the existing memory job worker, in small
 * cursor-checkpointed batches. It is a one-time, checkpoint-guarded, no-LLM data
 * backfill (migration-like), so it is consistent with the daemon-startup
 * philosophy of never blocking or doing expensive work at boot.
 *
 * Guards (all must pass to enqueue):
 * - Memory indexing must not be suppressed — memory enabled AND the memory
 *   plugin not disabled — using the same {@link isMemoryIndexingSuppressed}
 *   signal as the write/recall paths. When `memory.enabled === false` the memory
 *   job worker drains nothing (`runMemoryJobsOnce` returns early), so an enqueued
 *   backfill would sit pending forever and only accumulate dead rows. When the
 *   memory plugin is disabled via its `.disabled` sentinel, per-message index
 *   writes are suppressed, so completing a backfill would leave a stale index
 *   that a lexical-backed read could serve; gating on the same signal keeps the
 *   completion marker unset while writes are suppressed, so every read path stays
 *   on FTS in that state (the marker unifies them).
 * - The completion sentinel must be unset. Once the backfill has fully drained
 *   on this instance there is nothing to do; the marker makes this idempotent
 *   across restarts.
 * - No backfill job may already be pending or running. Without this, every
 *   restart during a long backfill would pile up a duplicate job. (The batches
 *   are idempotent, but redundant jobs waste worker cycles.)
 *
 * An instance that was already manually backfilled via the route but predates
 * the completion sentinel re-enqueues once here and re-runs the idempotent
 * backfill (no duplicate points; ~minutes) — an acceptable one-time cost.
 *
 * Best-effort and lightweight: any failure (e.g. the memory database is briefly
 * unavailable at boot) is swallowed and logged so a memory hiccup never blocks
 * daemon startup, matching the surrounding startup steps.
 */
export function maybeEnqueueLexicalBackfillOnUpgrade(): void {
  try {
    if (isMemoryIndexingSuppressed()) return;
    if (isLexicalBackfillComplete()) return;
    if (hasActiveJobOfType("backfill_lexical_index")) return;
    const jobId = enqueueMemoryJob("backfill_lexical_index", {});
    log.info(
      { jobId },
      "Enqueued one-time messages lexical-index backfill on startup",
    );
  } catch (err) {
    log.warn(
      { err },
      "Failed to enqueue startup lexical-index backfill (non-fatal)",
    );
  }
}

/** Messages indexed per job invocation before the job re-enqueues itself. */
const BATCH_SIZE = 200;

/**
 * Resumable, cursor-checkpointed backfill of existing messages into the Qdrant
 * lexical index. Selects the next {@link BATCH_SIZE} messages ordered by
 * `(createdAt asc, id asc)` after the persisted cursor, encodes each with the
 * local sparse encoder, batch-upserts them, advances the cursor, and
 * re-enqueues itself when the batch is full — draining the whole `messages`
 * table across many short invocations without blocking the event loop.
 *
 * Idempotent: the upsert keys on a deterministic point id derived from the
 * message id, so re-indexing the same message overwrites the same point. Pass
 * `payload.force` to reset the cursor and re-index from the beginning.
 */
export async function backfillLexicalIndexJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const db = getDb();
  const force = job.payload.force === true;
  if (force) {
    resetMessageCursorCheckpoint(
      LEXICAL_BACKFILL_CHECKPOINT_KEY,
      LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
    );
    // Clearing the completion sentinel lets a forced re-run drain and re-mark
    // as complete, and re-arms the one-time startup auto-enqueue for this run.
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
  }

  const cursor = readMessageCursorCheckpoint(
    LEXICAL_BACKFILL_CHECKPOINT_KEY,
    LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batch = db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      or(
        gt(messages.createdAt, cursor.createdAt),
        and(
          eq(messages.createdAt, cursor.createdAt),
          gt(messages.id, cursor.messageId),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(BATCH_SIZE)
    .all();

  if (batch.length > 0) {
    const index = resolveLexicalIndex(config);
    const points = batch.map((message) => ({
      messageId: message.id,
      sparse: generateSparseEmbedding(message.content),
      conversationId: message.conversationId,
      createdAt: message.createdAt,
    }));
    await withQdrantBreaker(() => index.upsertMessagesBatch(points));

    const lastMessage = batch[batch.length - 1];
    writeMessageCursorCheckpoint(
      LEXICAL_BACKFILL_CHECKPOINT_KEY,
      LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  // A full batch means there may be more rows past the new cursor — re-enqueue
  // to continue draining. Never carry `force` forward: the reset already
  // happened this invocation, and re-resetting would loop over the same head.
  if (batch.length === BATCH_SIZE) {
    enqueueMemoryJob("backfill_lexical_index", {});
  } else {
    // A short batch (including an empty one) means the cursor has reached the
    // end of the `messages` table — the backfill has fully drained. Record the
    // completion sentinel so the one-time startup auto-enqueue never schedules
    // it again on this instance. Idempotent: re-running after completion draws
    // an empty batch and simply re-sets the same marker.
    setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
  }
}
