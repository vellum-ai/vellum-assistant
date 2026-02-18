import { eq, desc, asc } from 'drizzle-orm';
import { getDb } from '../memory/db.js';
import { workItems } from '../memory/schema.js';

// ── Types ────────────────────────────────────────────────────────────

export type WorkItemStatus = 'queued' | 'running' | 'awaiting_review' | 'failed' | 'done' | 'archived';

export interface WorkItem {
  id: string;
  taskId: string;
  title: string;
  notes: string | null;
  status: WorkItemStatus;
  priorityTier: number;
  sortIndex: number | null;
  lastRunId: string | null;
  lastRunConversationId: string | null;
  lastRunStatus: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function createWorkItem(opts: {
  taskId: string;
  title: string;
  notes?: string;
  priorityTier?: number;
  sortIndex?: number;
  sourceType?: string;
  sourceId?: string;
}): WorkItem {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const item: WorkItem = {
    id,
    taskId: opts.taskId,
    title: opts.title,
    notes: opts.notes ?? null,
    status: 'queued',
    priorityTier: opts.priorityTier ?? 1,
    sortIndex: opts.sortIndex ?? null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: opts.sourceType ?? null,
    sourceId: opts.sourceId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workItems).values(item).run();
  return item;
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = getDb();
  return db.select().from(workItems).where(eq(workItems.id, id)).get() as WorkItem | undefined;
}

export function listWorkItems(opts?: { status?: WorkItemStatus }): WorkItem[] {
  const db = getDb();
  let query = db.select().from(workItems);
  if (opts?.status) {
    query = query.where(eq(workItems.status, opts.status)) as typeof query;
  }
  return query
    .orderBy(asc(workItems.priorityTier), asc(workItems.sortIndex), desc(workItems.updatedAt))
    .all() as WorkItem[];
}

export function updateWorkItem(
  id: string,
  updates: Partial<Pick<WorkItem, 'title' | 'notes' | 'status' | 'priorityTier' | 'sortIndex' | 'lastRunId' | 'lastRunConversationId' | 'lastRunStatus'>>,
): WorkItem | undefined {
  const db = getDb();
  db.update(workItems)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(workItems.id, id))
    .run();
  return getWorkItem(id);
}

export function deleteWorkItem(id: string): void {
  const db = getDb();
  db.delete(workItems).where(eq(workItems.id, id)).run();
}
