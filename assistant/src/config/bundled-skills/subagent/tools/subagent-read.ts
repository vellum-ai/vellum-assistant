import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeSubagentRead } from '../../../../tools/subagent/read.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentRead(input, context);
}
