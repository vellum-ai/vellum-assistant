import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskRun } from '../../../../tools/tasks/task-run.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskRun(input, context);
}
