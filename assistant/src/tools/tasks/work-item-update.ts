import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { resolveWorkItem, updateWorkItem, identifyEntityById, buildTaskTemplateMismatchError, type WorkItemStatus } from '../../work-items/work-item-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('task-list-update');

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
        enum: ['queued', 'running', 'awaiting_review', 'failed', 'archived'],
        description: 'New status for the work item',
      },
      sort_index: {
        type: 'number',
        description: 'Manual sort order within the same priority tier',
      },
      filter_priority_tier: {
        type: 'number',
        description:
          'Disambiguation filter: narrow by current priority tier (0=high, 1=medium, 2=low) when multiple items share the same title/task_id. This identifies WHICH item to update — it is NOT the new priority value.',
      },
      filter_status: {
        type: 'string',
        enum: ['queued', 'running', 'awaiting_review', 'failed', 'done', 'archived'],
        description:
          'Disambiguation filter: narrow by current status when multiple items share the same title/task_id.',
      },
      created_order: {
        type: 'number',
        description:
          'Disambiguation filter: pick the Nth oldest match (1 = oldest, 2 = second oldest, etc.) when multiple items share the same title/task_id.',
      },
    },
  },
};

export async function executeTaskListUpdate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const selectorType = input.work_item_id ? 'work_item_id' : input.task_id ? 'task_id' : input.task_name ? 'task_name' : input.title ? 'title' : 'none';

  try {
    // Build selector from whichever identifier was provided
    const selector = {
      workItemId: input.work_item_id as string | undefined,
      taskId: input.task_id as string | undefined,
      title: (input.task_name ?? input.title) as string | undefined,
      priorityTier: input.filter_priority_tier as number | undefined,
      status: input.filter_status as WorkItemStatus | undefined,
      createdOrder: input.created_order as number | undefined,
    };

    // Resolve the target work item
    const result = resolveWorkItem(selector);

    if (result.status === 'not_found') {
      // When the model passes an ID directly, check if it's a task template
      if (selector.workItemId) {
        const entity = identifyEntityById(selector.workItemId);
        if (entity.type === 'task_template') {
          log.warn({ selectorType, inputId: selector.workItemId }, 'task template ID passed as work_item_id');
          return {
            content: `Error: ${buildTaskTemplateMismatchError(selector.workItemId, entity.title!, 'task_delete to remove task templates, or task_list to view them')}`,
            isError: true,
          };
        }
      }
      log.warn({ selectorType, error: result.message }, 'work item not found for update');
      return { content: `Error: ${result.message}`, isError: true };
    }

    if (result.status === 'ambiguous') {
      log.warn({ selectorType, matchCount: result.matches.length }, 'ambiguous selector for update');
      return { content: `Error: ${result.message}`, isError: true };
    }

    const item = result.workItem;

    // Block direct transitions to 'done' — the only path to done is
    // through the Review action (handleWorkItemComplete in the daemon).
    if (input.status === 'done') {
      log.warn({ selectorType, resolvedWorkItemId: item.id }, 'rejected attempt to set status to done directly');
      return {
        content: 'Error: Cannot set status to \'done\' directly. Use the Review action in the Tasks window.',
        isError: true,
      };
    }

    log.info({ selectorType, selectorValue: input[selectorType], resolvedWorkItemId: item.id }, 'resolved work item for update');

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
      log.warn({ selectorType, resolvedWorkItemId: item.id }, 'update called with no fields to update');
      return {
        content: 'No updates specified. Provide at least one field to update (priority_tier, notes, status, sort_index).',
        isError: true,
      };
    }

    const updated = updateWorkItem(item.id, updates);
    if (!updated) {
      log.error({ selectorType, resolvedWorkItemId: item.id, updates }, 'updateWorkItem returned null');
      return {
        content: `Error: Failed to update work item "${item.title}".`,
        isError: true,
      };
    }

    log.info({ resolvedWorkItemId: item.id, updatedFields: Object.keys(updates) }, 'work item updated');

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
    log.error({ selectorType, error: msg }, 'update failed');
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskListUpdateTool implements Tool {
  name = 'task_list_update';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskListUpdate(input, _context);
  }
}

export const taskListUpdateTool = new TaskListUpdateTool();
