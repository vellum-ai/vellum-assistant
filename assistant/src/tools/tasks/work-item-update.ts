import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { resolveWorkItem, updateWorkItem, type WorkItemStatus } from '../../work-items/work-item-store.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'high',
  1: 'medium',
  2: 'low',
};

const definition: ToolDefinition = {
  name: 'task_list_update',
  description:
    'Update an existing task in the Task Queue. Can change priority, notes, status, or sort order. Identifies the task by work item ID, task ID, task name, or title.',
  input_schema: {
    type: 'object',
    properties: {
      work_item_id: {
        type: 'string',
        description: 'Direct work item ID (most precise selector)',
      },
      task_id: {
        type: 'string',
        description: 'Task definition ID to find the work item for',
      },
      task_name: {
        type: 'string',
        description: 'Task name/title to search for (case-insensitive exact match)',
      },
      title: {
        type: 'string',
        description: 'Work item title to search for (case-insensitive exact match)',
      },
      priority_tier: {
        type: 'number',
        description: '0 = high, 1 = medium, 2 = low',
      },
      notes: {
        type: 'string',
        description: 'Updated notes for the work item',
      },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'awaiting_review', 'failed', 'done', 'archived'],
        description: 'New status for the work item',
      },
      sort_index: {
        type: 'number',
        description: 'Manual sort order within the same priority tier',
      },
    },
  },
};

class TaskListUpdateTool implements Tool {
  name = 'task_list_update';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      // Build selector from whichever identifier was provided
      const selector = {
        workItemId: input.work_item_id as string | undefined,
        taskId: input.task_id as string | undefined,
        title: (input.task_name ?? input.title) as string | undefined,
      };

      // Resolve the target work item
      const item = resolveWorkItem(selector);

      // Build updates from provided fields
      const updates: Partial<{
        priorityTier: number;
        notes: string;
        status: WorkItemStatus;
        sortIndex: number;
      }> = {};
      if (input.priority_tier !== undefined) updates.priorityTier = input.priority_tier as number;
      if (input.notes !== undefined) updates.notes = input.notes as string;
      if (input.status !== undefined) updates.status = input.status as WorkItemStatus;
      if (input.sort_index !== undefined) updates.sortIndex = input.sort_index as number;

      if (Object.keys(updates).length === 0) {
        return {
          content: 'No updates specified. Provide at least one field to update (priority_tier, notes, status, sort_index).',
          isError: true,
        };
      }

      const updated = updateWorkItem(item.id, updates);
      if (!updated) {
        return {
          content: `Error: Failed to update work item "${item.title}".`,
          isError: true,
        };
      }

      // Build confirmation message
      const parts: string[] = [`Updated "${updated.title}"`];
      if (input.priority_tier !== undefined) {
        parts.push(`priority → ${PRIORITY_LABELS[updated.priorityTier] ?? updated.priorityTier}`);
      }
      if (input.notes !== undefined) parts.push('notes updated');
      if (input.status !== undefined) parts.push(`status → ${updated.status}`);
      if (input.sort_index !== undefined) parts.push(`sort index → ${updated.sortIndex}`);

      return { content: parts.join(', ') + '.', isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const taskListUpdateTool = new TaskListUpdateTool();
