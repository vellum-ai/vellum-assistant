import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { resolveWorkItem, removeWorkItemFromQueue } from '../../work-items/work-item-store.js';

const definition: ToolDefinition = {
  name: 'task_list_remove',
  description:
    'Remove a task from the Task Queue. Identifies the task by work item ID, task ID, task name, or title.',
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
    },
  },
};

class TaskListRemoveTool implements Tool {
  name = 'task_list_remove';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const selector = {
        workItemId: input.work_item_id as string | undefined,
        taskId: input.task_id as string | undefined,
        title: (input.task_name ?? input.title) as string | undefined,
      };

      const item = resolveWorkItem(selector);
      const result = removeWorkItemFromQueue(item.id);

      return { content: result.message, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const taskListRemoveTool = new TaskListRemoveTool();
