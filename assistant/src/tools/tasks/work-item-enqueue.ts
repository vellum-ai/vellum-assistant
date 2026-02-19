import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getTask, listTasks, createTask } from '../../tasks/task-store.js';
import { createWorkItem, findActiveWorkItemsByTitle, updateWorkItem } from '../../work-items/work-item-store.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'high',
  1: 'medium',
  2: 'low',
};

const definition: ToolDefinition = {
  name: 'task_list_add',
  description:
    'Add a task to the user\'s Task Queue. Use this when the user says "add to my tasks", "add to my queue", "put this on my task list", "track this task", or any variation of adding a one-off item they want to remember or work on. You can provide just a title for ad-hoc items, or reference an existing task definition by name or ID. Do NOT use schedule_create or reminder for simple "add to tasks" requests — those are for timed/recurring automation only.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID of an existing task definition to enqueue. Provide this, task_name, or just title.',
      },
      task_name: {
        type: 'string',
        description:
          'Title/name of an existing task definition to search for (case-insensitive substring match). Provide this, task_id, or just title.',
      },
      title: {
        type: 'string',
        description:
          'Title for the work item. When provided WITHOUT task_id or task_name, creates an ad-hoc work item directly (a lightweight task template is auto-created behind the scenes). When provided WITH task_id or task_name, overrides the task definition title.',
      },
      notes: {
        type: 'string',
        description: 'Notes to attach to the work item.',
      },
      priority_tier: {
        type: 'number',
        description: '0 = high, 1 = medium (default), 2 = low.',
      },
      sort_index: {
        type: 'number',
        description: 'Manual sort order within the priority tier.',
      },
      if_exists: {
        type: 'string',
        enum: ['create_duplicate', 'reuse_existing', 'update_existing'],
        description:
          'What to do if an active work item with the same title already exists. Defaults to "reuse_existing".',
      },
    },
  },
};

class TaskListAddTool implements Tool {
  name = 'task_list_add';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  /**
   * Check for an existing active work item with the same title and handle
   * according to the if_exists strategy. Returns a result if a duplicate was
   * found and handled, or null if no duplicate exists (caller should proceed).
   */
  private handleDuplicate(
    title: string,
    ifExists: string,
    input: Record<string, unknown>,
  ): ToolExecutionResult | null {
    const existing = findActiveWorkItemsByTitle(title);
    if (existing.length === 0) return null;

    const match = existing[0];

    if (ifExists === 'reuse_existing') {
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
      return {
        content: `Reused existing task "${match.title}" (ID: ${match.id}) instead of creating a duplicate.${
          Object.keys(updates).length > 0 ? ` Updated: ${Object.keys(updates).join(', ')}.` : ''
        }`,
        isError: false,
      };
    }

    return null;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
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
          const duplicateResult = this.handleDuplicate(titleOverride, ifExists, input);
          if (duplicateResult) return duplicateResult;
        }

        // Auto-create a lightweight task template for the ad-hoc item
        const adHocTask = createTask({
          title: titleOverride,
          template: titleOverride,
        });

        const workItem = createWorkItem({
          taskId: adHocTask.id,
          title: titleOverride,
          notes,
          priorityTier: priorityTier ?? 1,
          sortIndex,
        });

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
          return { content: `Error: No task definition found with ID "${taskId}".`, isError: true };
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
        const duplicateResult = this.handleDuplicate(finalTitle, ifExists, input);
        if (duplicateResult) return duplicateResult;
      }

      const workItem = createWorkItem({
        taskId: resolvedTask.id,
        title: finalTitle,
        notes,
        priorityTier: priorityTier ?? 1,
        sortIndex,
      });

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
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const taskListAddTool = new TaskListAddTool();
