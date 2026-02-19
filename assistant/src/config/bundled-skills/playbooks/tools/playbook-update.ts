import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executePlaybookUpdate } from '../../../../tools/playbooks/playbook-update.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executePlaybookUpdate(input, context);
}
