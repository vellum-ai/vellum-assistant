import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskListUpdate } from '../../../../tools/tasks/work-item-update.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListUpdate(input, context);
}
