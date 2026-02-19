import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeReminderCancel } from '../../../../tools/reminder/reminder.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeReminderCancel(input);
}
