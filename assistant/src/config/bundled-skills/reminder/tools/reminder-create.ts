import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeReminderCreate } from '../../../../tools/reminder/reminder.js';

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeReminderCreate(input);
}
