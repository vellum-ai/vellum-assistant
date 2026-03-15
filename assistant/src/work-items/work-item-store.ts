import { asc, desc, eq } from "drizzle-orm";

import { getDb } from "../memory/db.js";
import { workItems } from "../memory/schema.js";
import { getTask } from "../tasks/task-store.js";

// ── Types ────────────────────────────────────────────────────────────

export type WorkItemStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "failed"
  | "cancelled"
  | "done"
  | "archived";

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
  requiredTools: string | null;
  approvedTools: string | null;
  approvalStatus: string | null;
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
  requiredTools?: string;
}): WorkItem {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const item: WorkItem = {
    id,
    taskId: opts.taskId,
    title: opts.title,
    notes: opts.notes ?? null,
    status: "queued",
    priorityTier: opts.priorityTier ?? 1,
    sortIndex: opts.sortIndex ?? null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: opts.sourceType ?? null,
    sourceId: opts.sourceId ?? null,
    requiredTools: opts.requiredTools ?? null,
    approvedTools: null,
    approvalStatus: "none",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workItems).values(item).run();
  return item;
}

/**
 * Create a work item without any pre-approved permissions. Items start
 * with `approvalStatus: 'none'` and no `approvedTools` — approval
 * happens only via the explicit preflight flow before execution.
 */
export function createWorkItemWithPermissions(opts: {
  taskId: string;
  title: string;
  notes?: string;
  priorityTier?: number;
  sortIndex?: number;
  sourceType?: string;
  sourceId?: string;
  requiredTools?: string;
}): WorkItem {
  return createWorkItem(opts);
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = getDb();
  return db.select().from(workItems).where(eq(workItems.id, id)).get() as
    | WorkItem
    | undefined;
}

export function listWorkItems(opts?: { status?: WorkItemStatus }): WorkItem[] {
  const db = getDb();
  let query = db.select().from(workItems);
  if (opts?.status) {
    query = query.where(eq(workItems.status, opts.status)) as typeof query;
  }
  return query
    .orderBy(
      asc(workItems.priorityTier),
      asc(workItems.sortIndex),
      desc(workItems.updatedAt),
    )
    .all() as WorkItem[];
}

export function updateWorkItem(
  id: string,
  updates: Partial<
    Pick<
      WorkItem,
      | "title"
      | "notes"
      | "status"
      | "priorityTier"
      | "sortIndex"
      | "lastRunId"
      | "lastRunConversationId"
      | "lastRunStatus"
      | "requiredTools"
      | "approvedTools"
      | "approvalStatus"
    >
  >,
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

interface RemoveWorkItemResult {
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
    return {
      success: false,
      title: "",
      message: `No work item found with ID "${id}"`,
    };
  }
  deleteWorkItem(item.id);
  return {
    success: true,
    title: item.title,
    message: `Removed "${item.title}" from the task queue.`,
  };
}

// ── Selectors / Helpers ─────────────────────────────────────────────

interface WorkItemSelector {
  workItemId?: string;
  taskId?: string;
  title?: string;
  /** Disambiguator: filter by priority tier (0 = high, 1 = medium, 2 = low) */
  priorityTier?: number;
  /** Disambiguator: filter by status (queued, running, etc.) */
  status?: WorkItemStatus;
  /** Disambiguator: 1-indexed creation order (1 = oldest, 2 = second oldest, etc.) */
  createdOrder?: number;
}

export type ResolveWorkItemResult =
  | { status: "found"; workItem: WorkItem }
  | { status: "not_found"; message: string }
  | { status: "ambiguous"; matches: WorkItem[]; message: string };

const PRIORITY_TIER_LABELS: Record<number, string> = {
  0: "high",
  1: "medium",
  2: "low",
};

function formatAmbiguityMessage(
  selectorLabel: string,
  matches: WorkItem[],
): string {
  const lines = matches.map(
    (m) =>
      `  - ID: ${m.id} | title: "${m.title}" | priority: ${
        PRIORITY_TIER_LABELS[m.priorityTier] ?? m.priorityTier
      } | status: ${m.status}`,
  );
  return `Multiple items match '${selectorLabel}'. Please specify which one:\n${lines.join(
    "\n",
  )}`;
}

/** Find all active work items for a given task ID */
export function findActiveWorkItemsByTaskId(taskId: string): WorkItem[] {
  return listWorkItems().filter(
    (i) =>
      i.taskId === taskId && i.status !== "done" && i.status !== "archived",
  );
}

/** Find all active work items matching a title (case-insensitive exact match) */
export function findActiveWorkItemsByTitle(title: string): WorkItem[] {
  const normalized = title.trim().toLowerCase();
  return listWorkItems().filter(
    (i) =>
      i.title.trim().toLowerCase() === normalized &&
      i.status !== "done" &&
      i.status !== "archived",
  );
}

/**
 * Apply disambiguator fields to narrow down a set of candidate matches.
 * Filters by priorityTier, then status, then picks by createdOrder if provided.
 * Returns the filtered list (may still contain multiple items if disambiguation
 * fields are insufficient).
 */
function applyDisambiguators(
  items: WorkItem[],
  selector: WorkItemSelector,
): WorkItem[] {
  let filtered = items;

  if (selector.priorityTier !== undefined) {
    filtered = filtered.filter((i) => i.priorityTier === selector.priorityTier);
  }

  if (selector.status !== undefined) {
    filtered = filtered.filter((i) => i.status === selector.status);
  }

  if (selector.createdOrder !== undefined && filtered.length > 0) {
    const sorted = [...filtered].sort((a, b) => a.createdAt - b.createdAt);
    const idx = selector.createdOrder - 1; // convert 1-indexed to 0-indexed
    if (idx >= 0 && idx < sorted.length) {
      filtered = [sorted[idx]];
    }
    // If createdOrder is out of range, return the full filtered list so the
    // caller can report ambiguity with the remaining candidates.
  }

  return filtered;
}

/**
 * Given a list of candidate matches, apply disambiguators and return a resolution result.
 * Centralises the disambiguate-or-return-ambiguous logic shared across selector branches.
 */
function resolveFromCandidates(
  items: WorkItem[],
  selectorLabel: string,
  selector: WorkItemSelector,
): ResolveWorkItemResult {
  if (items.length === 0) {
    return {
      status: "not_found",
      message: `No active work item found for "${selectorLabel}"`,
    };
  }
  if (items.length === 1) {
    return { status: "found", workItem: items[0] };
  }

  // Multiple matches — try to narrow down with disambiguator fields
  const narrowed = applyDisambiguators(items, selector);

  if (narrowed.length === 1) {
    return { status: "found", workItem: narrowed[0] };
  }
  if (narrowed.length === 0) {
    // Disambiguators filtered out everything — report the original set so the
    // caller sees what was available
    return {
      status: "ambiguous",
      matches: items,
      message: formatAmbiguityMessage(selectorLabel, items),
    };
  }
  return {
    status: "ambiguous",
    matches: narrowed,
    message: formatAmbiguityMessage(selectorLabel, narrowed),
  };
}

/**
 * Resolve a single active work item from a selector.
 * Tries fields in priority order: workItemId > taskId > title.
 * Only considers active items (status not 'done' or 'archived').
 * Returns a discriminated union so callers can handle ambiguity explicitly
 * instead of silently picking one match when multiple exist.
 *
 * When multiple items match, the optional disambiguator fields (priorityTier,
 * status, createdOrder) are applied to narrow down the set.
 */
export function resolveWorkItem(
  selector: WorkItemSelector,
): ResolveWorkItemResult {
  if (selector.workItemId) {
    const item = getWorkItem(selector.workItemId);
    if (!item)
      return {
        status: "not_found",
        message: `No work item found with ID "${selector.workItemId}"`,
      };
    if (item.status === "done" || item.status === "archived") {
      return {
        status: "not_found",
        message: `Work item "${selector.workItemId}" is ${item.status}`,
      };
    }
    return { status: "found", workItem: item };
  }

  if (selector.taskId) {
    const items = findActiveWorkItemsByTaskId(selector.taskId);
    return resolveFromCandidates(items, selector.taskId, selector);
  }

  if (selector.title) {
    const items = findActiveWorkItemsByTitle(selector.title);
    return resolveFromCandidates(items, selector.title, selector);
  }

  return {
    status: "not_found",
    message:
      "At least one selector field (workItemId, taskId, or title) must be provided",
  };
}

// ── Entity Identification ───────────────────────────────────────────

type EntityType = "task_template" | "work_item" | "unknown";

interface EntityIdentification {
  type: EntityType;
  id: string;
  title?: string;
}

/**
 * Determine whether an ID refers to a task template (tasks table) or
 * a work item (work_items table). Used by tool error messages to give
 * the model corrective guidance when the wrong entity type is provided.
 */
export function identifyEntityById(id: string): EntityIdentification {
  const workItem = getWorkItem(id);
  if (workItem) {
    return { type: "work_item", id: workItem.id, title: workItem.title };
  }

  const task = getTask(id);
  if (task) {
    return { type: "task_template", id: task.id, title: task.title };
  }

  return { type: "unknown", id };
}

/**
 * Build a corrective error message when a work item ID is passed where
 * a task template ID is expected.
 */
export function buildWorkItemMismatchError(
  id: string,
  title: string,
  expectedTool: string,
): string {
  return [
    `Entity mismatch: The ID "${id}" refers to a work item ("${title}"), not a task template.`,
    `Corrective action: Use ${expectedTool} to operate on work items in the task queue.`,
    `Selector fields: work_item_id: "${id}" or title: "${title}"`,
  ].join("\n");
}

/**
 * Build a corrective error message when a task template ID is passed where
 * a work item ID is expected.
 */
export function buildTaskTemplateMismatchError(
  id: string,
  title: string,
  expectedTool: string,
): string {
  return [
    `Entity mismatch: The ID "${id}" refers to a task template ("${title}"), not a work item.`,
    `Corrective action: Use ${expectedTool} to operate on task templates.`,
    `Selector fields: task_id: "${id}" or task_name: "${title}"`,
  ].join("\n");
}
