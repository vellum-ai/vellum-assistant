import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { claudeCodeTool } from '../../../../tools/claude-code/claude-code.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return claudeCodeTool.execute(input, context);
}
