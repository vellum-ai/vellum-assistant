import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { rawGet } from "./db.js";
import { getMemoryBackendStatus } from "./embedding-backend.js";
import { enqueueBackfillJob, enqueueRebuildIndexJob } from "./indexer.js";
import {
  enqueueCleanupStaleSupersededItemsJob,
  getMemoryJobCounts,
} from "./jobs-store.js";
import { queryMemoryForCli } from "./retriever.js";

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
