import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { deleteTask, deleteTasks, getTask } from '../../tasks/task-store.js';

const definition: ToolDefinition = {
  name: 'task_delete',
  description: 'Delete one or more saved tasks by ID. Also removes associated task runs and work items.',
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

class TaskDeleteTool implements Tool {
  name = 'task_delete';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
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
          return { content: `No task found with ID ${ids[0]}`, isError: true };
        }
        return { content: `Deleted task: ${task?.title ?? ids[0]}`, isError: false };
      }

      const titles = ids.map((id) => {
        const t = getTask(id);
        return t ? t.title : id;
      });
      const count = deleteTasks(ids);
      if (count === 0) {
        return { content: 'No matching tasks found to delete.', isError: true };
      }
      const lines = [`Deleted ${count} task(s):`, ...titles.map((t) => `- ${t}`)];
      return { content: lines.join('\n'), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const taskDeleteTool = new TaskDeleteTool();
