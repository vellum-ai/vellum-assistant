import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeScheduleUpdate } from '../../../../tools/schedule/update.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeScheduleUpdate(input, context);
}
