import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { listWorkItems, type WorkItemStatus } from '../../work-items/work-item-store.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'urgent',
  1: 'high',
  2: 'normal',
  3: 'low',
};

const definition: ToolDefinition = {
  name: 'work_item_list',
  description: 'List all Tasks (work items) with their status, priority, and last run info.',
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

class WorkItemListTool implements Tool {
  name = 'work_item_list';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
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

      if (items.length === 0) {
        return { content: 'No Tasks found.', isError: false };
      }

      const lines = [`Found ${items.length} work item(s):`, ''];

      for (const item of items) {
        const priority = PRIORITY_LABELS[item.priorityTier] ?? `tier ${item.priorityTier}`;
        lines.push(`- ${item.title}`);
        lines.push(`    ID: ${item.id}`);
        lines.push(`    Status: ${item.status}`);
        lines.push(`    Priority: ${priority}`);
        if (item.notes) {
          lines.push(`    Notes: ${item.notes}`);
        }
        if (item.lastRunStatus) {
          lines.push(`    Last run: ${item.lastRunStatus}`);
        }
        lines.push('');
      }

      return { content: lines.join('\n'), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const workItemListTool = new WorkItemListTool();
