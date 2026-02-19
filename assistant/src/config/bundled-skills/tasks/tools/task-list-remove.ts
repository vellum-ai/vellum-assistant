import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskListRemove } from '../../../../tools/tasks/work-item-remove.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListRemove(input, context);
}
