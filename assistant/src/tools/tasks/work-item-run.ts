import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getWorkItem, listWorkItems, identifyEntityById, buildTaskTemplateMismatchError } from '../../work-items/work-item-store.js';
import { runWorkItemInBackground } from '../../work-items/work-item-runner.js';
import { getTask } from '../../tasks/task-store.js';

export async function executeTaskQueueRun(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const workItemId = input.work_item_id as string | undefined;
  const taskName = input.task_name as string | undefined;
  const title = input.title as string | undefined;

  if (!workItemId && !taskName && !title) {
    return {
      content: 'Error: Provide work_item_id, task_name, or title to identify the task to run.',
      isError: true,
    };
  }

  try {
    let resolvedId: string | undefined;

    if (workItemId) {
      const item = getWorkItem(workItemId);
      if (!item) {
        const entity = identifyEntityById(workItemId);
        if (entity.type === 'task_template') {
          return {
            content: `Error: ${buildTaskTemplateMismatchError(workItemId, entity.title!, 'task_list_show to view work items')}`,
            isError: true,
          };
        }
        return { content: `Error: No work item found with ID "${workItemId}".`, isError: true };
      }
      resolvedId = item.id;
    } else {
      // Search by task_name or title among active work items
      const needle = (taskName ?? title)!.toLowerCase();
      const allItems = listWorkItems();
      const activeItems = allItems.filter((i) => !['archived', 'done'].includes(i.status));
      const matches = activeItems.filter((i) => i.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return {
          content: `Error: No active work item matching "${taskName ?? title}". Use task_list_show to see your task queue.`,
          isError: true,
        };
      }

      if (matches.length > 1) {
        const lines = [`Multiple work items match "${taskName ?? title}". Please specify by ID:`, ''];
        for (const m of matches) {
          lines.push(`- ${m.title} (ID: ${m.id}, status: ${m.status})`);
        }
        return { content: lines.join('\n'), isError: true };
      }

      resolvedId = matches[0].id;
    }

    const result = runWorkItemInBackground(resolvedId);

    if (!result.success) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    const item = getWorkItem(resolvedId)!;
    const task = getTask(item.taskId);
    return {
      content: `Started running task "${item.title}"${task ? ` (template: ${task.title})` : ''}. It will execute in the background. Use task_list_show to check progress.`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
