import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getTask, listTasks } from '../../tasks/task-store.js';
import { renderTemplate } from '../../tasks/task-runner.js';
import { identifyEntityById, buildWorkItemMismatchError } from '../../work-items/work-item-store.js';

export async function executeTaskRun(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
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
        const entity = identifyEntityById(taskId);
        if (entity.type === 'work_item') {
          return {
            content: `Error: ${buildWorkItemMismatchError(taskId, entity.title!, 'task_list_show to view work items, or task_list_update to modify them')}`,
            isError: true,
          };
        }
        return { content: `Error: No task template found with ID "${taskId}". Use task_list to see available templates.`, isError: true };
      }
    } else if (taskName) {
      const allTasks = listTasks();
      const needle = taskName.toLowerCase();

      // Case-insensitive substring match
      task = allTasks.find((t) => t.title.toLowerCase().includes(needle));

      if (!task) {
        if (allTasks.length === 0) {
          return { content: 'Error: No task templates found. Use task_save to create one first.', isError: true };
        }
        const available = allTasks.map((t) => `  - "${t.title}" (${t.id})`).join('\n');
        return {
          content: `Error: No task template matching "${taskName}" found. Available templates:\n${available}`,
          isError: true,
        };
      }
    }

    if (!task) {
      return { content: 'Error: Could not resolve task template', isError: true };
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
      `Template "${task.title}" resolved and rendered.`,
      ``,
      `I'll now execute the following:`,
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
