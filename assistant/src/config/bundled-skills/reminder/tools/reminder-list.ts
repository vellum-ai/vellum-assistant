import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeReminderList } from '../../../../tools/reminder/reminder.js';

export async function run(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeReminderList();
}
