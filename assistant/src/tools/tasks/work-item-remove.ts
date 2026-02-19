import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { resolveWorkItem, removeWorkItemFromQueue, identifyEntityById, buildTaskTemplateMismatchError, type WorkItemStatus } from '../../work-items/work-item-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('task-list-remove');

const definition: ToolDefinition = {
  name: 'task_list_remove',
  description:
    'Remove a task from the Task Queue. Identifies the task by work item ID, task ID, task name, or title. When multiple items match, use the disambiguation fields (priority_tier, status, created_order) to narrow down.',
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
        description: 'Disambiguator: filter by priority tier (0 = high, 1 = medium, 2 = low)',
      },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'awaiting_review', 'failed', 'cancelled'],
        description: 'Disambiguator: filter by work item status',
      },
      created_order: {
        type: 'number',
        description: 'Disambiguator: 1-indexed creation order among matches (1 = oldest, 2 = second oldest, etc.)',
      },
    },
  },
};

export async function executeTaskListRemove(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const selectorType = input.work_item_id ? 'work_item_id' : input.task_id ? 'task_id' : input.task_name ? 'task_name' : input.title ? 'title' : 'none';

  try {
    const selector = {
      workItemId: input.work_item_id as string | undefined,
      taskId: input.task_id as string | undefined,
      title: (input.task_name ?? input.title) as string | undefined,
      priorityTier: input.priority_tier as number | undefined,
      status: input.status as WorkItemStatus | undefined,
      createdOrder: input.created_order as number | undefined,
    };

    const resolveResult = resolveWorkItem(selector);

    if (resolveResult.status === 'not_found') {
      // When the model passes an ID directly, check if it's a task template
      if (selector.workItemId) {
        const entity = identifyEntityById(selector.workItemId);
        if (entity.type === 'task_template') {
          log.warn({ selectorType, inputId: selector.workItemId }, 'task template ID passed as work_item_id');
          return {
            content: `Error: ${buildTaskTemplateMismatchError(selector.workItemId, entity.title!, 'task_delete to delete task templates')}`,
            isError: true,
          };
        }
      }
      log.warn({ selectorType, error: resolveResult.message }, 'work item not found for removal');
      return { content: `Error: ${resolveResult.message}`, isError: true };
    }

    if (resolveResult.status === 'ambiguous') {
      log.warn({ selectorType, matchCount: resolveResult.matches.length }, 'ambiguous selector for removal');
      return { content: `Error: ${resolveResult.message}`, isError: true };
    }

    const item = resolveResult.workItem;

    log.info({ selectorType, selectorValue: input[selectorType], resolvedWorkItemId: item.id, title: item.title }, 'resolved work item for removal');

    const removeResult = removeWorkItemFromQueue(item.id);

    log.info({ resolvedWorkItemId: item.id, deletedCount: 1 }, 'work item removed');

    return { content: removeResult.message, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ selectorType, error: msg }, 'remove failed');
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskListRemoveTool implements Tool {
  name = 'task_list_remove';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskListRemove(input, _context);
  }
}

export const taskListRemoveTool = new TaskListRemoveTool();
