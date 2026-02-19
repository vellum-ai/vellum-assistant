import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executePlaybookCreate } from '../../../../tools/playbooks/playbook-create.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executePlaybookCreate(input, context);
}
