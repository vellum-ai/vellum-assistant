import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getTask, listTasks } from '../../tasks/task-store.js';
import { renderTemplate } from '../../tasks/task-runner.js';

const definition: ToolDefinition = {
  name: 'task_run',
  description:
    'Run a previously saved task. Resolves the task by name (fuzzy match) or ID, renders its template with the provided inputs, and returns the rendered template for execution.',
  input_schema: {
    type: 'object',
    properties: {
      task_name: {
        type: 'string',
        description: 'Fuzzy match a task by name (case-insensitive substring match)',
      },
      task_id: {
        type: 'string',
        description: 'Exact match a task by ID',
      },
      inputs: {
        type: 'object',
        description: 'Values for template placeholders (e.g. {"file_path": "/tmp/foo.txt", "url": "https://example.com"})',
        additionalProperties: { type: 'string' },
      },
    },
  },
};

class TaskRunTool implements Tool {
  name = 'task_run';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const taskName = input.task_name as string | undefined;
    const taskId = input.task_id as string | undefined;
    const inputs = (input.inputs as Record<string, string> | undefined) ?? {};

    if (!taskName && !taskId) {
      return {
        content: 'Error: At least one of task_name or task_id must be provided',
        isError: true,
      };
    }

    try {
      // Resolve the task
      let task;

      if (taskId) {
        task = getTask(taskId);
        if (!task) {
          return { content: `Error: No task found with ID "${taskId}"`, isError: true };
        }
      } else if (taskName) {
        const allTasks = listTasks();
        const needle = taskName.toLowerCase();

        // Case-insensitive substring match
        task = allTasks.find((t) => t.title.toLowerCase().includes(needle));

        if (!task) {
          if (allTasks.length === 0) {
            return { content: 'Error: No saved tasks found. Use task_save to create one first.', isError: true };
          }
          const available = allTasks.map((t) => `  - "${t.title}" (${t.id})`).join('\n');
          return {
            content: `Error: No task matching "${taskName}" found. Available tasks:\n${available}`,
            isError: true,
          };
        }
      }

      if (!task) {
        return { content: 'Error: Could not resolve task', isError: true };
      }

      // Check if required inputs are provided
      if (task.inputSchema) {
        const schema = JSON.parse(task.inputSchema) as { properties?: Record<string, unknown> };
        if (schema.properties) {
          const requiredKeys = Object.keys(schema.properties);
          const missingKeys = requiredKeys.filter((k) => !(k in inputs));
          if (missingKeys.length > 0) {
            return {
              content: `Error: Missing required inputs: ${missingKeys.join(', ')}. Provide them in the "inputs" parameter.`,
              isError: true,
            };
          }
        }
      }

      // Render the template
      const rendered = renderTemplate(task.template, inputs);

      const requiredTools: string[] = task.requiredTools ? JSON.parse(task.requiredTools) : [];

      const lines = [
        `Task "${task.title}" resolved and template rendered.`,
        ``,
        `Task template rendered. I'll now execute the following task:`,
        ``,
        rendered,
      ];

      if (requiredTools.length > 0) {
        lines.push('', `Required tools: ${requiredTools.join(', ')}`);
      }

      return { content: lines.join('\n'), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const taskRunTool = new TaskRunTool();
