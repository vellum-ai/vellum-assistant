import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { deleteTask, deleteTasks, getTask } from '../../tasks/task-store.js';
import { removeWorkItemFromQueue } from '../../work-items/work-item-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('task-delete');

const definition: ToolDefinition = {
  name: 'task_delete',
  description: 'Delete one or more task templates by ID. Also removes associated task runs and work items (Tasks).',
  input_schema: {
    type: 'object',
    properties: {
      task_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more task IDs to delete.',
      },
    },
    required: ['task_ids'],
  },
};

export async function executeTaskDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const raw = input.task_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { content: 'Error: task_ids must be a non-empty array of task ID strings', isError: true };
  }
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (ids.length === 0) {
    return { content: 'Error: task_ids must contain at least one non-empty string', isError: true };
  }

  try {
    if (ids.length === 1) {
      const task = getTask(ids[0]);
      const deleted = deleteTask(ids[0]);
      if (!deleted) {
        // The LLM may pass a work item ID instead of a task template ID.
        // Fall back to removing from the task queue so the user's intent succeeds.
        const result = removeWorkItemFromQueue(ids[0]);
        if (result.success) {
          log.info({ inputId: ids[0], fallback: true, deletedCount: 1 }, 'deleted via work item fallback');
          return { content: result.message, isError: false };
        }
        log.warn({ inputId: ids[0] }, 'no task or work item found for deletion');
        return { content: `No task template or work item found with ID "${ids[0]}". Use task_list to see task templates or task_list_show to see work items in the queue.`, isError: true };
      }
      log.info({ taskId: ids[0], title: task?.title, deletedCount: 1 }, 'task deleted');
      return { content: `Deleted task: ${task?.title ?? ids[0]}`, isError: false };
    }

    const taskIds: string[] = [];
    const taskTitles: string[] = [];
    const workItemTitles: string[] = [];

    for (const id of ids) {
      const task = getTask(id);
      if (task) {
        taskIds.push(id);
        taskTitles.push(task.title);
      } else {
        const result = removeWorkItemFromQueue(id);
        if (result.success) {
          log.info({ inputId: id, fallback: true }, 'deleted work item in batch (fallback)');
          workItemTitles.push(result.title);
        } else {
          log.warn({ inputId: id }, 'batch delete: no task or work item found');
        }
      }
    }

    const taskCount = taskIds.length > 0 ? deleteTasks(taskIds) : 0;

    if (taskCount === 0 && workItemTitles.length === 0) {
      log.warn({ inputIds: ids }, 'no matching tasks found to delete');
      return { content: 'No matching tasks found to delete.', isError: true };
    }

    log.info({ deletedTasks: taskCount, deletedWorkItems: workItemTitles.length, totalInput: ids.length }, 'batch delete completed');

    const lines: string[] = [];
    if (taskCount > 0) {
      lines.push(`Deleted ${taskCount} task(s):`, ...taskTitles.map((t) => `- ${t}`));
    }
    if (workItemTitles.length > 0) {
      lines.push(`Removed ${workItemTitles.length} item(s) from the task queue:`, ...workItemTitles.map((t) => `- ${t}`));
    }
    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ inputIds: ids, error: msg }, 'delete failed');
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskDeleteTool implements Tool {
  name = 'task_delete';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskDelete(input, _context);
  }
}

export const taskDeleteTool = new TaskDeleteTool();
