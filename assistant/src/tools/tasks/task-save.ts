import type { ToolContext, ToolExecutionResult } from '../types.js';
import { compileTaskFromConversation, saveCompiledTask } from '../../tasks/task-compiler.js';

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
