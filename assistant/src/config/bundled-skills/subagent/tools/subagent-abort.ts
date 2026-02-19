import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeSubagentAbort } from '../../../../tools/subagent/abort.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentAbort(input, context);
}
