import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskSave } from '../../../../tools/tasks/task-save.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskSave(input, context);
}
