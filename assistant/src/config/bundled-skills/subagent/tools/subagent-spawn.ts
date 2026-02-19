import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeSubagentSpawn } from '../../../../tools/subagent/spawn.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentSpawn(input, context);
}
