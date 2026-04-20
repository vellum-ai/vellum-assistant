import { and, count, desc, eq, sql } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { deleteMemoryCheckpoint } from "./checkpoints.js";
import { getConversationMemoryScopeId } from "./conversation-crud.js";
import { getDb, rawGet } from "./db.js";
import { getMemoryBackendStatus } from "./embedding-backend.js";
import {
  type CompactionOptions,
  type CompactionResult,
  compactLongMemories,
} from "./graph/compaction.js";
import { handleRecall, type RecallResult } from "./graph/tool-handlers.js";
import {
  enqueueBackfillJob,
  enqueueRebuildIndexJob,
  MIN_SEGMENT_CHARS,
} from "./indexer.js";
import { enqueueMemoryJob, getMemoryJobCounts } from "./jobs-store.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { getQdrantClient } from "./qdrant-client.js";
import {
  conversations,
  memorySegments,
  memorySummaries,
  messages,
} from "./schema.js";

const log = getLogger("memory-admin");

export interface MemorySystemStatus {
  enabled: boolean;
  degraded: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  counts: {
    segments: number;
    graphNodes: number;
    summaries: number;
    embeddings: number;
  };
  jobs: Record<string, number>;
}

export async function getMemorySystemStatus(): Promise<MemorySystemStatus> {
  const config = getConfig();
  const backend = await getMemoryBackendStatus(config);
  const counts = {
    segments: countTable("memory_segments"),
    graphNodes: countTable("memory_graph_nodes"),
    summaries: countTable("memory_summaries"),
    embeddings: countTable("memory_embeddings"),
  };
  return {
    enabled: backend.enabled,
    degraded: backend.degraded,
    reason: backend.reason,
    provider: backend.provider,
    model: backend.model,
    counts,
    jobs: getMemoryJobCounts(),
  };

  function countTable(table: string): number {
    return rawGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0;
  }
}

export function requestMemoryBackfill(force = false): string {
  const id = enqueueBackfillJob(force);
  log.info({ jobId: id }, "Queued memory backfill job");
  return id;
}

export function requestMemoryRebuildIndex(): string {
  const id = enqueueRebuildIndexJob();
  log.info({ jobId: id }, "Queued memory index rebuild job");
  return id;
}

export async function queryMemory(
  query: string,
  _conversationId: string,
): Promise<RecallResult> {
  const config = getConfig();
  return handleRecall({ query }, config, "default");
}

// ── Short segment cleanup ─────────────────────────────────────────────

export interface CleanupShortSegmentsResult {
  removed: number;
  failed: number;
  dryRunCount?: number;
}

/**
 * Remove segments shorter than MIN_SEGMENT_CHARS from SQLite and Qdrant.
 * These short fragments waste embedding budget, retrieval slots, and
 * injection tokens.
 */
export async function cleanupShortSegments(opts?: {
  dryRun?: boolean;
}): Promise<CleanupShortSegmentsResult> {
  const db = getDb();

  const shortSegments = db
    .select({ id: memorySegments.id })
    .from(memorySegments)
    .where(sql`length(${memorySegments.text}) < ${MIN_SEGMENT_CHARS}`)
    .all();

  if (opts?.dryRun) {
    return { removed: 0, failed: 0, dryRunCount: shortSegments.length };
  }

  let removed = 0;
  let failed = 0;
  for (const row of shortSegments) {
    try {
      const qdrant = getQdrantClient();
      await withQdrantBreaker(() => qdrant.deleteByTarget("segment", row.id));
    } catch (err) {
      // Keep the SQLite row so the target ID is preserved for retry
      log.warn(
        { segmentId: row.id, err },
        "Qdrant deletion failed — skipping SQLite deletion to preserve target ID",
      );
      failed++;
      continue;
    }

    db.delete(memorySegments).where(eq(memorySegments.id, row.id)).run();
    removed++;
  }

  log.info(
    { removed, failed, threshold: MIN_SEGMENT_CHARS },
    "Cleaned up short segments",
  );
  return { removed, failed };
}

// ── Long-memory compaction ────────────────────────────────────────────

/**
 * One-off backfill that rewrites over-long memory node content to fit the
 * extraction prompt's 1-3 sentence / ~300 character length cap. Preview
 * mode (opts.apply=false) lists candidates without calling the LLM.
 */
export async function compactLongMemoryNodes(
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  return compactLongMemories(opts);
}

// ── Re-extraction ──────────────────────────────────────────────────────

export interface ReextractTarget {
  conversationId: string;
  title: string | null;
  messageCount: number;
}

/**
 * Find the top N conversations by message count for re-extraction.
 * Excludes background and private conversations.
 */
export function findReextractTargets(limit: number): ReextractTarget[] {
  const db = getDb();
  interface Row {
    id: string;
    title: string | null;
    msg_count: number;
  }
  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      msg_count: count(messages.id),
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      sql`${conversations.conversationType} NOT IN ('background', 'private', 'scheduled')`,
    )
    .groupBy(conversations.id)
    .orderBy(desc(sql`count(${messages.id})`))
    .limit(limit)
    .all() as Row[];

  return rows.map((r) => ({
    conversationId: r.id,
    title: r.title,
    messageCount: r.msg_count,
  }));
}

/**
 * Look up a conversation for re-extraction targeting.
 */
export function findReextractTarget(
  conversationId: string,
): ReextractTarget | null {
  const db = getDb();
  const conv = db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conv) return null;

  const [{ total }] = db
    .select({ total: count() })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .all();

  return {
    conversationId: conv.id,
    title: conv.title,
    messageCount: total,
  };
}

/**
 * Queue re-extraction for a set of conversations.
 * Resets extraction checkpoints and clears extraction summaries so the
 * graph extraction handler processes all messages from scratch with
 * expanded supersession context.
 */
export function requestReextract(targets: ReextractTarget[]): {
  jobIds: string[];
} {
  const db = getDb();
  const jobIds: string[] = [];

  for (const target of targets) {
    const { conversationId } = target;

    // Reset graph extraction checkpoints
    deleteMemoryCheckpoint(`graph_extract:${conversationId}:last_ts`);
    deleteMemoryCheckpoint(`graph_extract:${conversationId}:pending_count`);

    // Clear the extraction summary so it starts fresh
    db.delete(memorySummaries)
      .where(
        and(
          eq(memorySummaries.scope, "extraction_context"),
          eq(memorySummaries.scopeKey, conversationId),
        ),
      )
      .run();

    // Resolve scope and enqueue re-extraction
    const scopeId = getConversationMemoryScopeId(conversationId);
    const jobId = enqueueMemoryJob("graph_extract", {
      conversationId,
      scopeId,
    });
    jobIds.push(jobId);

    log.info(
      { conversationId, title: target.title, messages: target.messageCount },
      "Queued re-extraction job",
    );
  }

  return { jobIds };
}
