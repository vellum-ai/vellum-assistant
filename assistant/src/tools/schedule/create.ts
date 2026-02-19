import type { ToolContext, ToolExecutionResult } from '../types.js';
import { createSchedule, isValidCronExpression, formatLocalDate, describeCronExpression } from '../../schedule/schedule-store.js';
import { normalizeScheduleSyntax } from '../../schedule/recurrence-types.js';
import { validateRruleSetLines } from '../../schedule/recurrence-engine.js';

export async function executeScheduleCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const name = input.name as string;
  const timezone = (input.timezone as string) ?? null;
  const message = input.message as string;
  const enabled = (input.enabled as boolean) ?? true;

  if (!name || typeof name !== 'string') {
    return { content: 'Error: name is required and must be a string', isError: true };
  }
  if (!message || typeof message !== 'string') {
    return { content: 'Error: message is required and must be a string', isError: true };
  }

  // Resolve syntax and expression from new or legacy fields
  const resolved = normalizeScheduleSyntax({
    syntax: input.syntax as 'cron' | 'rrule' | undefined,
    expression: input.expression as string | undefined,
    legacyCronExpression: input.cron_expression as string | undefined,
  });

  if (!resolved) {
    return { content: 'Error: expression (or cron_expression) is required', isError: true };
  }

  // Syntax-specific pre-validation for actionable error messages
  if (resolved.syntax === 'cron' && !isValidCronExpression(resolved.expression)) {
    return { content: `Error: Invalid cron expression: "${resolved.expression}"`, isError: true };
  }
  if (resolved.syntax === 'rrule') {
    const setError = validateRruleSetLines(resolved.expression);
    if (setError) {
      return {
        content: `Error: ${setError}. Supported line types: DTSTART, RRULE, RDATE, EXDATE, EXRULE.`,
        isError: true,
      };
    }
  }

  try {
    const job = createSchedule({
      name,
      cronExpression: resolved.expression,
      timezone,
      message,
      enabled,
      syntax: resolved.syntax,
      expression: resolved.expression,
    });

    const scheduleDescription = job.syntax === 'rrule'
      ? job.expression
      : describeCronExpression(job.cronExpression);

    const nextRunDate = formatLocalDate(job.nextRunAt);
    return {
      content: [
        `Schedule created successfully.`,
        `  Name: ${job.name}`,
        `  Syntax: ${job.syntax}`,
        `  Schedule: ${scheduleDescription}${job.timezone ? ` (${job.timezone})` : ''}`,
        `  Enabled: ${job.enabled}`,
        `  Next run: ${nextRunDate}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating schedule: ${msg}`, isError: true };
  }
}
