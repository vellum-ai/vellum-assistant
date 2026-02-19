import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getTask, listTasks, createTask } from '../../tasks/task-store.js';
import { createWorkItemWithPermissions, findActiveWorkItemsByTitle, updateWorkItem, identifyEntityById, buildWorkItemMismatchError } from '../../work-items/work-item-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('task-list-add');

const PRIORITY_LABELS: Record<number, string> = {
  0: 'high',
  1: 'medium',
  2: 'low',
};

function handleDuplicate(
  title: string,
  ifExists: string,
  input: Record<string, unknown>,
): ToolExecutionResult | null {
  const existing = findActiveWorkItemsByTitle(title);
  if (existing.length === 0) return null;

  const match = existing[0];
  log.info({ title, existingId: match.id, ifExists }, 'task_list_add: duplicate detected');

  if (ifExists === 'reuse_existing') {
    log.info({ title, existingId: match.id }, 'task_list_add: reused existing item');
    return {
      content: `Task "${match.title}" already exists in the queue (ID: ${match.id}, status: ${match.status}). Use task_list_update to modify it.`,
      isError: false,
    };
  }

  if (ifExists === 'update_existing') {
    const updates: Partial<{ title: string; notes: string; priorityTier: number; sortIndex: number }> = {};
    if (input.priority_tier !== undefined) updates.priorityTier = input.priority_tier as number;
    if (input.notes !== undefined) updates.notes = input.notes as string;
    if (input.sort_index !== undefined) updates.sortIndex = input.sort_index as number;
    if (Object.keys(updates).length > 0) {
      updateWorkItem(match.id, updates);
    }
    log.info({ title, existingId: match.id, updates }, 'task_list_add: updated existing item');
    return {
      content: `Reused existing task "${match.title}" (ID: ${match.id}) instead of creating a duplicate.${
        Object.keys(updates).length > 0 ? ` Updated: ${Object.keys(updates).join(', ')}.` : ''
      }`,
      isError: false,
    };
  }

  return null;
}

export async function executeTaskListAdd(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const taskId = input.task_id as string | undefined;
    const taskName = input.task_name as string | undefined;
    const titleOverride = input.title as string | undefined;
    const notes = input.notes as string | undefined;
    const priorityTier = input.priority_tier as number | undefined;
    const sortIndex = input.sort_index as number | undefined;

    const ifExists = (input.if_exists as string) || 'reuse_existing';

    // Ad-hoc mode: title provided without task_id or task_name
    if (!taskId && !taskName) {
      if (!titleOverride) {
        return {
          content: 'Error: You must provide either task_id, task_name, or title to create a work item.',
          isError: true,
        };
      }

      // Duplicate-prevention guard
      if (ifExists !== 'create_duplicate') {
        const duplicateResult = handleDuplicate(titleOverride, ifExists, input);
        if (duplicateResult) return duplicateResult;
      } else {
        log.info({ title: titleOverride }, 'task_list_add: creating duplicate (if_exists=create_duplicate)');
      }

      log.debug({ title: titleOverride }, 'task_list_add: creating new item');

      // Auto-create a lightweight task template for the ad-hoc item
      const adHocTask = createTask({
        title: titleOverride,
        template: titleOverride,
      });

      const workItem = createWorkItemWithPermissions({
        taskId: adHocTask.id,
        title: titleOverride,
        notes,
        priorityTier: priorityTier ?? 1,
        sortIndex,
      });

      log.info({ selectorType: 'title', workItemId: workItem.id, title: workItem.title }, 'ad-hoc work item created');

      const priority = PRIORITY_LABELS[workItem.priorityTier] ?? `tier ${workItem.priorityTier}`;
      const lines = [
        `Enqueued work item:`,
        `  Title: ${workItem.title}`,
        `  ID: ${workItem.id}`,
        `  Priority: ${priority}`,
        `  Status: ${workItem.status}`,
      ];
      if (workItem.notes) {
        lines.push(`  Notes: ${workItem.notes}`);
      }
      if (workItem.sortIndex !== null) {
        lines.push(`  Sort index: ${workItem.sortIndex}`);
      }

      return { content: lines.join('\n'), isError: false };
    }

    let resolvedTask;

    if (taskId) {
      resolvedTask = getTask(taskId);
      if (!resolvedTask) {
        const entity = identifyEntityById(taskId);
        if (entity.type === 'work_item') {
          return {
            content: `Error: ${buildWorkItemMismatchError(taskId, entity.title!, 'task_list_update to modify the existing work item, or task_list_add with just a title for a new ad-hoc item')}`,
            isError: true,
          };
        }
        return { content: `Error: No task definition found with ID "${taskId}". Use task_list to see available task templates, or provide just a title to create an ad-hoc work item.`, isError: true };
      }
    } else {
      // Search by name (case-insensitive substring match)
      const needle = taskName!.toLowerCase();
      const allTasks = listTasks();
      const matches = allTasks.filter((t) => t.title.toLowerCase().includes(needle));

      if (matches.length === 0) {
        return {
          content: `Error: No task definition found matching "${taskName}". Use task_list to see available tasks.`,
          isError: true,
        };
      }

      if (matches.length > 1) {
        const lines = [
          `Multiple task definitions match "${taskName}". Please specify by ID:`,
          '',
        ];
        for (const m of matches) {
          lines.push(`- ${m.title}  (ID: ${m.id})`);
        }
        return { content: lines.join('\n'), isError: true };
      }

      resolvedTask = matches[0];
    }

    const finalTitle = titleOverride ?? resolvedTask.title;

    // Duplicate-prevention guard
    if (ifExists !== 'create_duplicate') {
      const duplicateResult = handleDuplicate(finalTitle, ifExists, input);
      if (duplicateResult) return duplicateResult;
    } else {
      log.info({ title: finalTitle }, 'task_list_add: creating duplicate (if_exists=create_duplicate)');
    }

    log.debug({ title: finalTitle }, 'task_list_add: creating new item');

    const selectorType = taskId ? 'task_id' : 'task_name';
    const workItem = createWorkItemWithPermissions({
      taskId: resolvedTask.id,
      title: finalTitle,
      notes,
      priorityTier: priorityTier ?? 1,
      sortIndex,
    });

    log.info({ selectorType, taskId: resolvedTask.id, workItemId: workItem.id, title: workItem.title }, 'work item created from task definition');

    const priority = PRIORITY_LABELS[workItem.priorityTier] ?? `tier ${workItem.priorityTier}`;
    const lines = [
      `Enqueued work item:`,
      `  Title: ${workItem.title}`,
      `  ID: ${workItem.id}`,
      `  Task definition: ${resolvedTask.title} (${resolvedTask.id})`,
      `  Priority: ${priority}`,
      `  Status: ${workItem.status}`,
    ];
    if (workItem.notes) {
      lines.push(`  Notes: ${workItem.notes}`);
    }
    if (workItem.sortIndex !== null) {
      lines.push(`  Sort index: ${workItem.sortIndex}`);
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'enqueue failed');
    return { content: `Error: ${msg}`, isError: true };
  }
}
