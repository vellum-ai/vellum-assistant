import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { getMemoryBackendStatus } from './embedding-backend.js';
import { getDb } from './db.js';
import { enqueueBackfillJob, enqueueRebuildIndexJob } from './indexer.js';
import { getMemoryJobCounts } from './jobs-store.js';
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
  jobs: Record<string, number>;
}

export function getMemorySystemStatus(): MemorySystemStatus {
  const config = getConfig();
  const backend = getMemoryBackendStatus(config);
  const db = getDb();
  const raw = (db as unknown as { $client: { query: (q: string) => { get: () => unknown } } }).$client;
  const counts = {
    segments: countTable('memory_segments'),
    items: countTable('memory_items'),
    summaries: countTable('memory_summaries'),
    embeddings: countTable('memory_embeddings'),
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
    const row = raw.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | null;
    return row?.c ?? 0;
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

export async function queryMemory(
  query: string,
  conversationId: string,
) {
  return queryMemoryForCli(query, conversationId, getConfig());
}
