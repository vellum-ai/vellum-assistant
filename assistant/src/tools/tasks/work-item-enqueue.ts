import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getTask, listTasks } from '../../tasks/task-store.js';
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
    'Add a task to the Task Queue. Creates a work item from a task definition (template) by name or ID.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID of the task definition to enqueue. Provide this or task_name.',
      },
      task_name: {
        type: 'string',
        description:
          'Title/name of the task definition to search for (case-insensitive substring match). Provide this or task_id.',
      },
      title: {
        type: 'string',
        description:
          'Override title for the work item. Defaults to the task definition title if omitted.',
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

      if (!taskId && !taskName) {
        return {
          content: 'Error: You must provide either task_id or task_name to identify the task definition.',
          isError: true,
        };
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
