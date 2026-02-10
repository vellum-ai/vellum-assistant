import { and, asc, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { memoryJobs } from './schema.js';

export type MemoryJobType =
  | 'embed_segment'
  | 'embed_item'
  | 'embed_summary'
  | 'extract_items'
  | 'refresh_weekly_summary'
  | 'refresh_monthly_summary'
  | 'build_conversation_summary'
  | 'backfill'
  | 'rebuild_index';

export interface MemoryJob<T = Record<string, unknown>> {
  id: string;
  type: MemoryJobType;
  payload: T;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  runAfter: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export function enqueueMemoryJob(
  type: MemoryJobType,
  payload: Record<string, unknown>,
  runAfter = Date.now(),
): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(memoryJobs).values({
    id,
    type,
    payload: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    runAfter,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

export function claimMemoryJobs(limit: number): MemoryJob[] {
  if (limit <= 0) return [];
  const db = getDb();
  const now = Date.now();
  const candidates = db
    .select()
    .from(memoryJobs)
    .where(and(eq(memoryJobs.status, 'pending'), lte(memoryJobs.runAfter, now)))
    .orderBy(asc(memoryJobs.runAfter), asc(memoryJobs.createdAt))
    .limit(limit)
    .all();

  const claimed: MemoryJob[] = [];
  for (const row of candidates) {
    db.update(memoryJobs)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(memoryJobs.id, row.id), eq(memoryJobs.status, 'pending')))
      .run();
    claimed.push(parseRow({
      ...row,
      status: 'running',
      updatedAt: now,
    }));
  }
  return claimed;
}

export function completeMemoryJob(id: string): void {
  const db = getDb();
  db.update(memoryJobs)
    .set({ status: 'completed', updatedAt: Date.now(), lastError: null })
    .where(eq(memoryJobs.id, id))
    .run();
}

export function failMemoryJob(
  id: string,
  error: string,
  options?: { retryDelayMs?: number; maxAttempts?: number },
): void {
  const retryDelayMs = options?.retryDelayMs ?? 30_000;
  const maxAttempts = options?.maxAttempts ?? 5;
  const db = getDb();
  const row = db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, id))
    .get();
  if (!row) return;
  const attempts = row.attempts + 1;
  const now = Date.now();
  if (attempts >= maxAttempts) {
    db.update(memoryJobs)
      .set({
        status: 'failed',
        attempts,
        updatedAt: now,
        lastError: error.slice(0, 2000),
      })
      .where(eq(memoryJobs.id, id))
      .run();
    return;
  }
  db.update(memoryJobs)
    .set({
      status: 'pending',
      attempts,
      runAfter: now + retryDelayMs,
      updatedAt: now,
      lastError: error.slice(0, 2000),
    })
    .where(eq(memoryJobs.id, id))
    .run();
}

export function resetRunningJobsToPending(): number {
  const db = getDb();
  const runningRows = db
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(eq(memoryJobs.status, 'running'))
    .all();
  db.update(memoryJobs)
    .set({ status: 'pending', updatedAt: Date.now() })
    .where(eq(memoryJobs.status, 'running'))
    .run();
  return runningRows.length;
}

export function getMemoryJobCounts(): Record<string, number> {
  const db = getDb();
  const raw = (db as unknown as { $client: { query: (q: string) => { all: () => unknown[] } } }).$client;
  const rows = raw.query(`
    SELECT status, COUNT(*) AS c
    FROM memory_jobs
    GROUP BY status
  `).all() as Array<{ status: string; c: number }>;
  const counts: Record<string, number> = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    counts[row.status] = row.c;
  }
  return counts;
}

function parseRow(row: typeof memoryJobs.$inferSelect): MemoryJob {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    type: row.type as MemoryJobType,
    payload,
    status: row.status as MemoryJob['status'],
    attempts: row.attempts,
    runAfter: row.runAfter,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
