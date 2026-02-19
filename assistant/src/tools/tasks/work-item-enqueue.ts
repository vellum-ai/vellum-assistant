import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getTask, listTasks, createTask } from '../../tasks/task-store.js';
import { createWorkItem } from '../../work-items/work-item-store.js';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'urgent',
  1: 'high',
  2: 'normal',
  3: 'low',
};

const definition: ToolDefinition = {
  name: 'work_item_enqueue',
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
        description: '0 = urgent, 1 = high, 2 = normal (default), 3 = low.',
      },
      sort_index: {
        type: 'number',
        description: 'Manual sort order within the priority tier.',
      },
    },
  },
};

class WorkItemEnqueueTool implements Tool {
  name = 'work_item_enqueue';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const taskId = input.task_id as string | undefined;
      const taskName = input.task_name as string | undefined;
      const titleOverride = input.title as string | undefined;
      const notes = input.notes as string | undefined;
      const priorityTier = input.priority_tier as number | undefined;
      const sortIndex = input.sort_index as number | undefined;

      // Ad-hoc mode: title provided without task_id or task_name
      if (!taskId && !taskName) {
        if (!titleOverride) {
          return {
            content: 'Error: You must provide either task_id, task_name, or title to create a work item.',
            isError: true,
          };
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
          priorityTier: priorityTier ?? 2,
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

      const workItem = createWorkItem({
        taskId: resolvedTask.id,
        title: titleOverride ?? resolvedTask.title,
        notes,
        priorityTier: priorityTier ?? 2,
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

export const workItemEnqueueTool = new WorkItemEnqueueTool();
