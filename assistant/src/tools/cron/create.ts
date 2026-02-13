import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { createCronJob, isValidCronExpression, formatLocalDate, describeCronExpression } from '../../cron/cron-store.js';

class CronCreateTool implements Tool {
  name = 'cron_create';
  description = 'Create a scheduled cron job that sends a message at a recurring interval';
  category = 'cron';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A human-readable name for the cron job',
          },
          cron_expression: {
            type: 'string',
            description: 'A cron expression (e.g. "0 9 * * 1-5" for weekdays at 9am). Supports standard 5-field cron syntax.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to system timezone if omitted.',
          },
          message: {
            type: 'string',
            description: 'The message to send to the assistant when the cron job triggers',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the job is enabled immediately. Defaults to true.',
          },
        },
        required: ['name', 'cron_expression', 'message'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const name = input.name as string;
    const cronExpression = input.cron_expression as string;
    const timezone = (input.timezone as string) ?? null;
    const message = input.message as string;
    const enabled = (input.enabled as boolean) ?? true;

    if (!name || typeof name !== 'string') {
      return { content: 'Error: name is required and must be a string', isError: true };
    }
    if (!cronExpression || typeof cronExpression !== 'string') {
      return { content: 'Error: cron_expression is required and must be a string', isError: true };
    }
    if (!message || typeof message !== 'string') {
      return { content: 'Error: message is required and must be a string', isError: true };
    }
    if (!isValidCronExpression(cronExpression)) {
      return { content: `Error: Invalid cron expression: "${cronExpression}"`, isError: true };
    }

    try {
      const job = createCronJob({ name, cronExpression, timezone, message, enabled });
      const nextRunDate = formatLocalDate(job.nextRunAt);
      return {
        content: [
          `Cron job created successfully.`,
          `  ID: ${job.id}`,
          `  Name: ${job.name}`,
          `  Schedule: ${describeCronExpression(job.cronExpression)} (${job.cronExpression})${job.timezone ? ` (${job.timezone})` : ''}`,
          `  Enabled: ${job.enabled}`,
          `  Next run: ${nextRunDate}`,
        ].join('\n'),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error creating cron job: ${msg}`, isError: true };
    }
  }
}

registerTool(new CronCreateTool());
