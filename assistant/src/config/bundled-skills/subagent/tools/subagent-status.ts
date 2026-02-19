import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeSubagentStatus } from '../../../../tools/subagent/status.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentStatus(input, context);
}
