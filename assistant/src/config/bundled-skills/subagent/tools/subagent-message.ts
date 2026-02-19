import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeSubagentMessage } from '../../../../tools/subagent/message.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentMessage(input, context);
}
