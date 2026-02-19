import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { listTasks } from '../../tasks/task-store.js';

const definition: ToolDefinition = {
  name: 'task_list',
  description: 'List saved task templates (reusable definitions). To see your active Tasks (work items), use task_list_show instead.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export async function executeTaskList(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const tasks = listTasks();

    if (tasks.length === 0) {
      return { content: 'No task templates found. Use task_save to create one from a conversation.\n\nTip: To see your active Tasks (work items in the queue), use the task_list_show tool.', isError: false };
    }

    const lines = [`Found ${tasks.length} task template(s):`, ''];

    for (const task of tasks) {
      const requiredTools: string[] = task.requiredTools ? JSON.parse(task.requiredTools) : [];
      const createdAt = new Date(task.createdAt).toISOString();

      lines.push(`- ${task.title}`);
      lines.push(`    ID: ${task.id}`);
      lines.push(`    Status: ${task.status}`);
      lines.push(`    Created: ${createdAt}`);
      if (requiredTools.length > 0) {
        lines.push(`    Required tools: ${requiredTools.join(', ')}`);
      }
      if (task.inputSchema) {
        const schema = JSON.parse(task.inputSchema) as { properties?: Record<string, unknown> };
        if (schema.properties) {
          lines.push(`    Inputs: ${Object.keys(schema.properties).join(', ')}`);
        }
      }
      lines.push('');
    }

    lines.push('Tip: To see your active Tasks (work items in the queue), use the task_list_show tool.');

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskListTool implements Tool {
  name = 'task_list';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskList(_input, _context);
  }
}

export const taskListTool = new TaskListTool();
