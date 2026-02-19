import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { compileTaskFromConversation, saveCompiledTask } from '../../tasks/task-compiler.js';

const definition: ToolDefinition = {
  name: 'task_save',
  description:
    'Save the current conversation as a reusable task template (definition). This is NOT for adding items to the user\'s task queue — use task_list_add for that. task_save extracts the conversation pattern into a reusable definition with placeholders that can be run later with different inputs.',
  input_schema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation to capture as a task template. If omitted, uses the current conversation.',
      },
      title: {
        type: 'string',
        description: 'Optional override for the auto-generated task title',
      },
    },
    required: [],
  },
};

export async function executeTaskSave(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const conversationId = (input.conversation_id as string | undefined) || context.conversationId;
  if (!conversationId || typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    return { content: 'Error: conversation_id is required and must be a non-empty string', isError: true };
  }

  const titleOverride = input.title as string | undefined;

  try {
    const compiled = compileTaskFromConversation(conversationId);

    if (titleOverride && typeof titleOverride === 'string' && titleOverride.trim().length > 0) {
      compiled.title = titleOverride.trim();
    }

    const task = saveCompiledTask(compiled, conversationId);

    const lines = [
      `Task saved successfully.`,
      `  ID: ${task.id}`,
      `  Title: ${task.title}`,
      `  Template: ${task.template}`,
    ];

    if (compiled.requiredTools.length > 0) {
      lines.push(`  Required tools: ${compiled.requiredTools.join(', ')}`);
    }

    if (compiled.inputSchema) {
      const props = (compiled.inputSchema as Record<string, unknown>).properties as Record<string, unknown> | undefined;
      if (props) {
        lines.push(`  Input placeholders: ${Object.keys(props).join(', ')}`);
      }
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

class TaskSaveTool implements Tool {
  name = 'task_save';
  description = definition.description;
  category = 'tasks';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeTaskSave(input, context);
  }
}

export const taskSaveTool = new TaskSaveTool();
