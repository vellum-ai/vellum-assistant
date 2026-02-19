import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { listWorkItems, type WorkItemStatus } from '../../work-items/work-item-store.js';

const definition: ToolDefinition = {
  name: 'task_list_show',
  description: 'List the user\'s Task Queue (work items) with their status, priority, and last run info. Use this when the user says "show my tasks", "what\'s in my queue", "what\'s on my task list", or similar.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description:
          'Optional status filter. A single status string (e.g. "queued") or an array of statuses to include.',
      },
    },
  },
};

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

    return { content: `Opened Tasks window (${label}).`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskListShowTool implements Tool {
  name = 'task_list_show';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskListShow(input, _context);
  }
}

export const taskListShowTool = new TaskListShowTool();
