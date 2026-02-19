import type { ToolContext, ToolExecutionResult } from '../types.js';
import { resolveWorkItem, removeWorkItemFromQueue, identifyEntityById, buildTaskTemplateMismatchError, type WorkItemStatus } from '../../work-items/work-item-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('task-list-remove');

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
