import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { listPendingConflictDetails, resolveConflict } from './conflict-store.js';
import { rawGet } from './db.js';
import { getMemoryBackendStatus } from './embedding-backend.js';
import { enqueueBackfillJob, enqueueRebuildIndexJob } from './indexer.js';
import {
  enqueueCleanupResolvedConflictsJob,
  enqueueCleanupStaleSupersededItemsJob,
  getMemoryJobCounts,
} from './jobs-store.js';
import { queryMemoryForCli } from './retriever.js';

const log = getLogger('memory-admin');

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
  conflicts: {
    pending: number;
    resolved: number;
    oldestPendingAgeMs: number | null;
  };
  cleanup: {
    resolvedBacklog: number;
    supersededBacklog: number;
    resolvedCompleted24h: number;
    supersededCompleted24h: number;
  };
  jobs: Record<string, number>;
}

export interface MemoryConflictAndCleanupStats {
  conflicts: MemorySystemStatus['conflicts'];
  cleanup: MemorySystemStatus['cleanup'];
}

interface ConflictStatsRow {
  pending_count: number | null;
  resolved_count: number | null;
  oldest_pending_created_at: number | null;
}

interface CleanupStatsRow {
  resolved_backlog: number | null;
  superseded_backlog: number | null;
  resolved_completed_24h: number | null;
  superseded_completed_24h: number | null;
}

/** Lightweight query for conflict/cleanup metrics only — no table counts or job totals. */
export function getMemoryConflictAndCleanupStats(): MemoryConflictAndCleanupStats {
  const conflictStats = rawGet<ConflictStatsRow>(`
    SELECT
      SUM(CASE WHEN status = 'pending_clarification' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status != 'pending_clarification' THEN 1 ELSE 0 END) AS resolved_count,
      MIN(CASE WHEN status = 'pending_clarification' THEN created_at END) AS oldest_pending_created_at
    FROM memory_item_conflicts
  `);
  const pending = conflictStats?.pending_count ?? 0;
  const oldestPendingCreatedAt = conflictStats?.oldest_pending_created_at ?? null;
  const oldestPendingAgeMs = oldestPendingCreatedAt == null
    ? null
    : Math.max(0, Date.now() - oldestPendingCreatedAt);
  const throughputWindowStartMs = Date.now() - (24 * 60 * 60 * 1000);
  const cleanupStats = rawGet<CleanupStatsRow>(`
    SELECT
      SUM(CASE
        WHEN type = 'cleanup_resolved_conflicts' AND status IN ('pending', 'running')
        THEN 1 ELSE 0 END
      ) AS resolved_backlog,
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status IN ('pending', 'running')
        THEN 1 ELSE 0 END
      ) AS superseded_backlog,
      SUM(CASE
        WHEN type = 'cleanup_resolved_conflicts' AND status = 'completed' AND updated_at >= ?
        THEN 1 ELSE 0 END
      ) AS resolved_completed_24h,
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status = 'completed' AND updated_at >= ?
        THEN 1 ELSE 0 END
      ) AS superseded_completed_24h
    FROM memory_jobs
  `, throughputWindowStartMs, throughputWindowStartMs);
  return {
    conflicts: {
      pending,
      resolved: conflictStats?.resolved_count ?? 0,
      oldestPendingAgeMs,
    },
    cleanup: {
      resolvedBacklog: cleanupStats?.resolved_backlog ?? 0,
      supersededBacklog: cleanupStats?.superseded_backlog ?? 0,
      resolvedCompleted24h: cleanupStats?.resolved_completed_24h ?? 0,
      supersededCompleted24h: cleanupStats?.superseded_completed_24h ?? 0,
    },
  };
}

export function getMemorySystemStatus(): MemorySystemStatus {
  const config = getConfig();
  const backend = getMemoryBackendStatus(config);
  const counts = {
    segments: countTable('memory_segments'),
    items: countTable('memory_items'),
    summaries: countTable('memory_summaries'),
    embeddings: countTable('memory_embeddings'),
  };
  const conflictStats = rawGet<ConflictStatsRow>(`
    SELECT
      SUM(CASE WHEN status = 'pending_clarification' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status != 'pending_clarification' THEN 1 ELSE 0 END) AS resolved_count,
      MIN(CASE WHEN status = 'pending_clarification' THEN created_at END) AS oldest_pending_created_at
    FROM memory_item_conflicts
  `);
  const pending = conflictStats?.pending_count ?? 0;
  const oldestPendingCreatedAt = conflictStats?.oldest_pending_created_at ?? null;
  const oldestPendingAgeMs = oldestPendingCreatedAt == null
    ? null
    : Math.max(0, Date.now() - oldestPendingCreatedAt);
  const throughputWindowStartMs = Date.now() - (24 * 60 * 60 * 1000);
  const cleanupStats = rawGet<CleanupStatsRow>(`
    SELECT
      SUM(CASE
        WHEN type = 'cleanup_resolved_conflicts' AND status IN ('pending', 'running')
        THEN 1 ELSE 0 END
      ) AS resolved_backlog,
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status IN ('pending', 'running')
        THEN 1 ELSE 0 END
      ) AS superseded_backlog,
      SUM(CASE
        WHEN type = 'cleanup_resolved_conflicts' AND status = 'completed' AND updated_at >= ?
        THEN 1 ELSE 0 END
      ) AS resolved_completed_24h,
      SUM(CASE
        WHEN type = 'cleanup_stale_superseded_items' AND status = 'completed' AND updated_at >= ?
        THEN 1 ELSE 0 END
      ) AS superseded_completed_24h
    FROM memory_jobs
  `, throughputWindowStartMs, throughputWindowStartMs);
  return {
    enabled: backend.enabled,
    degraded: backend.degraded,
    reason: backend.reason,
    provider: backend.provider,
    model: backend.model,
    counts,
    conflicts: {
      pending,
      resolved: conflictStats?.resolved_count ?? 0,
      oldestPendingAgeMs,
    },
    cleanup: {
      resolvedBacklog: cleanupStats?.resolved_backlog ?? 0,
      supersededBacklog: cleanupStats?.superseded_backlog ?? 0,
      resolvedCompleted24h: cleanupStats?.resolved_completed_24h ?? 0,
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
  log.info({ jobId: id }, 'Queued memory backfill job');
  return id;
}

export function requestMemoryRebuildIndex(): string {
  const id = enqueueRebuildIndexJob();
  log.info({ jobId: id }, 'Queued memory index rebuild job');
  return id;
}

export function requestMemoryCleanup(retentionMs?: number): { resolvedConflictsJobId: string; staleSupersededItemsJobId: string } {
  const resolvedConflictsJobId = enqueueCleanupResolvedConflictsJob(retentionMs);
  const staleSupersededItemsJobId = enqueueCleanupStaleSupersededItemsJob(retentionMs);
  log.info({ resolvedConflictsJobId, staleSupersededItemsJobId, retentionMs }, 'Queued memory cleanup jobs');
  return { resolvedConflictsJobId, staleSupersededItemsJobId };
}

export async function queryMemory(
  query: string,
  conversationId: string,
) {
  return queryMemoryForCli(query, conversationId, getConfig());
}

export interface DismissConflictsResult {
  dismissed: number;
  remaining: number;
  details: Array<{ id: string; existingStatement: string; candidateStatement: string }>;
}

/**
 * Dismiss pending memory conflicts. With `all: true`, dismisses every
 * pending conflict. Otherwise, dismisses only conflicts matching the
 * given `pattern` regex against either statement.
 */
export function dismissPendingConflicts(
  options: { all?: boolean; pattern?: RegExp; scopeId?: string },
): DismissConflictsResult {
  const scopeId = options.scopeId ?? 'default';
  const dismissed: DismissConflictsResult['details'] = [];
  const BATCH_SIZE = 1000;

  // Cursor-based pagination: track last seen (createdAt, id) to advance past
  // previously inspected rows. This ensures pattern mode scans all pending
  // conflicts even when non-matching rows outnumber the batch size.
  let cursor: { createdAt: number; id: string } | undefined;
  let batch = listPendingConflictDetails(scopeId, BATCH_SIZE);
  while (batch.length > 0) {
    for (const conflict of batch) {
      const matches = options.all
        || (options.pattern && (
          options.pattern.test(conflict.existingStatement)
          || options.pattern.test(conflict.candidateStatement)
        ));
      if (!matches) continue;

      resolveConflict(conflict.id, {
        status: 'dismissed',
        resolutionNote: options.all
          ? 'Bulk dismissed via CLI (dismiss-conflicts --all).'
          : `Dismissed via CLI (pattern: ${options.pattern?.source}).`,
      });
      dismissed.push({
        id: conflict.id,
        existingStatement: conflict.existingStatement,
        candidateStatement: conflict.candidateStatement,
      });
    }
    // No more rows to inspect
    if (batch.length < BATCH_SIZE) break;
    const lastRow = batch[batch.length - 1];
    cursor = { createdAt: lastRow.createdAt, id: lastRow.id };
    batch = listPendingConflictDetails(scopeId, BATCH_SIZE, cursor);
  }

  // Get true remaining count via SQL to avoid batch-size truncation
  const remaining = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_item_conflicts WHERE scope_id = ? AND status = 'pending_clarification'`,
    scopeId,
  )?.c ?? 0;

  log.info({ dismissed: dismissed.length, remaining, scopeId }, 'Dismissed pending conflicts');
  return {
    dismissed: dismissed.length,
    remaining,
    details: dismissed,
  };
}
