import type { ToolContext, ToolExecutionResult } from '../types.js';
import { listWorkItems, type WorkItem, type WorkItemStatus } from '../../work-items/work-item-store.js';

const PRIORITY_LABELS: Record<number, string> = { 0: 'High', 1: 'Medium', 2: 'Low' };

function formatTaskList(items: WorkItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const priority = PRIORITY_LABELS[item.priorityTier] ?? 'Medium';
    const status = item.status.replace(/_/g, ' ');
    lines.push(`- [${priority}] ${item.title} (${status})`);
  }
  return lines.join('\n');
}

export async function executeTaskListShow(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const statusFilter = input.status as string | string[] | undefined;

    let items;
    if (typeof statusFilter === 'string') {
      items = listWorkItems({ status: statusFilter as WorkItemStatus });
    } else if (Array.isArray(statusFilter)) {
      // listWorkItems only supports a single status filter, so we fetch all
      // and filter client-side when an array is provided
      const allItems = listWorkItems();
      const allowed = new Set(statusFilter);
      items = allItems.filter((item) => allowed.has(item.status));
    } else {
      items = listWorkItems();
    }

    const count = items.length;
    const filtered = statusFilter !== undefined;

    if (count === 0) {
      const suffix = filtered ? 'no items matching filter.' : 'no tasks queued.';
      return { content: `Opened Tasks window \u2014 ${suffix}`, isError: false };
    }

    const label = filtered
      ? `${count} ${Array.isArray(statusFilter) ? 'matching' : statusFilter} item${count === 1 ? '' : 's'}`
      : `${count} item${count === 1 ? '' : 's'}`;

    const taskList = formatTaskList(items);

    return { content: `Opened Tasks window (${label}).\n\nCurrent tasks:\n${taskList}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
