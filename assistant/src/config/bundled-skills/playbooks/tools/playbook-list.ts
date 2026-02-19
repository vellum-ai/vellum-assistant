import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executePlaybookList } from '../../../../tools/playbooks/playbook-list.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executePlaybookList(input, context);
}
