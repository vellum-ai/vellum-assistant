import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeBrowserClick } from '../../../../tools/browser/browser-execution.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeBrowserClick(input, context);
}
