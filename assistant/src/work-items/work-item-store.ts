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

// ── Queue Removal ───────────────────────────────────────────────────

export interface RemoveWorkItemResult {
  success: boolean;
  title: string;
  message: string;
}

/**
 * Shared helper for removing a single work item from the queue by ID.
 * Used by both task_delete (compat path) and task_list_remove so all
 * single-item deletions follow one codepath.
 */
export function removeWorkItemFromQueue(id: string): RemoveWorkItemResult {
  const item = getWorkItem(id);
  if (!item) {
    return { success: false, title: '', message: `No work item found with ID "${id}"` };
  }
  deleteWorkItem(item.id);
  return { success: true, title: item.title, message: `Removed "${item.title}" from the task queue.` };
}

// ── Selectors / Helpers ─────────────────────────────────────────────

export interface WorkItemSelector {
  workItemId?: string;
  taskId?: string;
  title?: string;
}

export type ResolveWorkItemResult =
  | { status: 'found'; workItem: WorkItem }
  | { status: 'not_found'; message: string }
  | { status: 'ambiguous'; matches: WorkItem[]; message: string };

const PRIORITY_TIER_LABELS: Record<number, string> = { 0: 'high', 1: 'medium', 2: 'low' };

function formatAmbiguityMessage(selectorLabel: string, matches: WorkItem[]): string {
  const lines = matches.map(
    m =>
      `  - ID: ${m.id} | title: "${m.title}" | priority: ${PRIORITY_TIER_LABELS[m.priorityTier] ?? m.priorityTier} | status: ${m.status}`,
  );
  return `Multiple items match '${selectorLabel}'. Please specify which one:\n${lines.join('\n')}`;
}

/** Find all active work items for a given task ID */
export function findActiveWorkItemsByTaskId(taskId: string): WorkItem[] {
  return listWorkItems().filter(
    i => i.taskId === taskId && i.status !== 'done' && i.status !== 'archived'
  );
}

/** Find all active work items matching a title (case-insensitive exact match) */
export function findActiveWorkItemsByTitle(title: string): WorkItem[] {
  const normalized = title.trim().toLowerCase();
  return listWorkItems().filter(
    i => i.title.trim().toLowerCase() === normalized && i.status !== 'done' && i.status !== 'archived'
  );
}

/**
 * Resolve a single active work item from a selector.
 * Tries fields in priority order: workItemId > taskId > title.
 * Only considers active items (status not 'done' or 'archived').
 * Returns a discriminated union so callers can handle ambiguity explicitly
 * instead of silently picking one match when multiple exist.
 */
export function resolveWorkItem(selector: WorkItemSelector): ResolveWorkItemResult {
  if (selector.workItemId) {
    const item = getWorkItem(selector.workItemId);
    if (!item) return { status: 'not_found', message: `No work item found with ID "${selector.workItemId}"` };
    if (item.status === 'done' || item.status === 'archived') {
      return { status: 'not_found', message: `Work item "${selector.workItemId}" is ${item.status}` };
    }
    return { status: 'found', workItem: item };
  }

  if (selector.taskId) {
    const items = findActiveWorkItemsByTaskId(selector.taskId);
    if (items.length === 0) return { status: 'not_found', message: `No active work item found for task "${selector.taskId}"` };
    if (items.length > 1) {
      return { status: 'ambiguous', matches: items, message: formatAmbiguityMessage(selector.taskId, items) };
    }
    return { status: 'found', workItem: items[0] };
  }

  if (selector.title) {
    const items = findActiveWorkItemsByTitle(selector.title);
    if (items.length === 0) return { status: 'not_found', message: `No active work item found with title "${selector.title}"` };
    if (items.length > 1) {
      return { status: 'ambiguous', matches: items, message: formatAmbiguityMessage(selector.title, items) };
    }
    return { status: 'found', workItem: items[0] };
  }

  return { status: 'not_found', message: 'At least one selector field (workItemId, taskId, or title) must be provided' };
}
