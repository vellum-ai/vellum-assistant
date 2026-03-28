import { and, count, desc, eq, sql } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { deleteMemoryCheckpoint } from "./checkpoints.js";
import { getConversationMemoryScopeId } from "./conversation-crud.js";
import { getDb, rawGet } from "./db.js";
import { getMemoryBackendStatus } from "./embedding-backend.js";
import { enqueueBackfillJob, enqueueRebuildIndexJob, MIN_SEGMENT_CHARS } from "./indexer.js";
import {
  enqueueCleanupStaleSupersededItemsJob,
  enqueueMemoryJob,
  getMemoryJobCounts,
} from "./jobs-store.js";
import { getQdrantClient } from "./qdrant-client.js";
import { withQdrantBreaker } from "./qdrant-circuit-breaker.js";
import { queryMemoryForCli } from "./retriever.js";
import { conversations, memorySegments, memorySummaries, messages } from "./schema.js";

const log = getLogger("memory-admin");

export interface MemorySystemStatus {
  enabled: boolean;
  degraded: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  counts: {
    segments: number;
    items: number;
    summaries: number;
    embeddings: number;
  };
  cleanup: {
    supersededBacklog: number;
    supersededCompleted24h: number;
  };
  jobs: Record<string, number>;
}

interface CleanupStatsRow {
  superseded_backlog: number | null;
  superseded_completed_24h: number | null;
}

export async function getMemorySystemStatus(): Promise<MemorySystemStatus> {
  const config = getConfig();
  const backend = await getMemoryBackendStatus(config);
  const counts = {
    segments: countTable("memory_segments"),
    items: countTable("memory_items"),
    summaries: countTable("memory_summaries"),
    embeddings: countTable("memory_embeddings"),
  };
  const throughputWindowStartMs = Date.now() - 24 * 60 * 60 * 1000;
  const cleanupStats = rawGet<CleanupStatsRow>(
    `
    SELECT
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status IN ('pending', 'running')
        THEN 1 ELSE 0 END
      ) AS superseded_backlog,
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status = 'completed' AND updated_at >= ?
        THEN 1 ELSE 0 END
      ) AS superseded_completed_24h
    FROM memory_jobs
  `,
    throughputWindowStartMs,
  );
  return {
    enabled: backend.enabled,
    degraded: backend.degraded,
    reason: backend.reason,
    provider: backend.provider,
    model: backend.model,
    counts,
    cleanup: {
      supersededBacklog: cleanupStats?.superseded_backlog ?? 0,
      supersededCompleted24h: cleanupStats?.superseded_completed_24h ?? 0,
    },
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

export function requestMemoryCleanup(retentionMs?: number): {
  staleSupersededItemsJobId: string;
} {
  const staleSupersededItemsJobId =
    enqueueCleanupStaleSupersededItemsJob(retentionMs);
  log.info(
    { staleSupersededItemsJobId, retentionMs },
    "Queued memory cleanup jobs",
  );
  return { staleSupersededItemsJobId };
}

export async function queryMemory(query: string, conversationId: string) {
  return queryMemoryForCli(query, conversationId, getConfig());
}

// ── Short segment cleanup ─────────────────────────────────────────────

export interface CleanupShortSegmentsResult {
  removed: number;
  dryRunCount?: number;
}

/**
 * Remove segments shorter than MIN_SEGMENT_CHARS from SQLite and Qdrant.
 * These short fragments waste embedding budget, retrieval slots, and
 * injection tokens.
 */
export async function cleanupShortSegments(
  opts?: { dryRun?: boolean },
): Promise<CleanupShortSegmentsResult> {
  const db = getDb();

  const shortSegments = db
    .select({ id: memorySegments.id })
    .from(memorySegments)
    .where(sql`length(${memorySegments.text}) < ${MIN_SEGMENT_CHARS}`)
    .all();

  if (opts?.dryRun) {
    return { removed: 0, dryRunCount: shortSegments.length };
  }

  let removed = 0;
  for (const row of shortSegments) {
    // Delete the Qdrant embedding first (best-effort via circuit breaker)
    try {
      const qdrant = getQdrantClient();
      await withQdrantBreaker(() => qdrant.deleteByTarget("segment", row.id));
    } catch {
      // Qdrant may not be running or the vector may not exist — continue
      // with SQLite deletion regardless
    }

    db.delete(memorySegments)
      .where(eq(memorySegments.id, row.id))
      .run();
    removed++;
  }

  log.info({ removed, threshold: MIN_SEGMENT_CHARS }, "Cleaned up short segments");
  return { removed };
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
      sql`${conversations.conversationType} NOT IN ('background', 'private')`,
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
 * batch extraction handler processes all messages from scratch with
 * expanded supersession context.
 */
export function requestReextract(
  targets: ReextractTarget[],
): { jobIds: string[] } {
  const db = getDb();
  const jobIds: string[] = [];

  for (const target of targets) {
    const { conversationId } = target;

    // Reset batch extraction checkpoints
    deleteMemoryCheckpoint(
      `batch_extract:${conversationId}:last_message_id`,
    );
    deleteMemoryCheckpoint(
      `batch_extract:${conversationId}:pending_count`,
    );

    // Clear the extraction summary so it starts fresh
    db.delete(memorySummaries)
      .where(
        and(
          eq(memorySummaries.scope, "extraction_context"),
          eq(memorySummaries.scopeKey, conversationId),
        ),
      )
      .run();

    // Resolve scope and enqueue with fullReextract flag
    const scopeId = getConversationMemoryScopeId(conversationId);
    const jobId = enqueueMemoryJob("batch_extract", {
      conversationId,
      scopeId,
      fullReextract: true,
    });
    jobIds.push(jobId);

    log.info(
      { conversationId, title: target.title, messages: target.messageCount },
      "Queued re-extraction job",
    );
  }

  return { jobIds };
}
