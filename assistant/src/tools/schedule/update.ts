import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { updateSchedule, formatLocalDate, describeCronExpression } from '../../schedule/schedule-store.js';

class ScheduleUpdateTool implements Tool {
  name = 'schedule_update';
  description = 'Update an existing scheduled task (schedule, message, name, or enabled state)';
  category = 'schedule';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'The ID of the schedule to update',
          },
          name: {
            type: 'string',
            description: 'New name for the job',
          },
          cron_expression: {
            type: 'string',
            description: 'New cron expression',
          },
          timezone: {
            type: 'string',
            description: 'New IANA timezone',
          },
          message: {
            type: 'string',
            description: 'New message to send when triggered',
          },
          enabled: {
            type: 'boolean',
            description: 'Enable or disable the job',
          },
        },
        required: ['job_id'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const jobId = input.job_id as string;
    if (!jobId || typeof jobId !== 'string') {
      return { content: 'Error: job_id is required', isError: true };
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.cron_expression !== undefined) updates.cronExpression = input.cron_expression;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.message !== undefined) updates.message = input.message;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    if (Object.keys(updates).length === 0) {
      return { content: 'Error: No updates provided. Specify at least one field to update.', isError: true };
    }

    try {
      const job = updateSchedule(jobId, updates as {
        name?: string;
        cronExpression?: string;
        timezone?: string | null;
        message?: string;
        enabled?: boolean;
      });

      if (!job) {
        return { content: `Error: Schedule not found: ${jobId}`, isError: true };
      }

      return {
        content: [
          `Schedule updated successfully.`,
          `  Name: ${job.name}`,
          `  Schedule: ${describeCronExpression(job.cronExpression)}${job.timezone ? ` (${job.timezone})` : ''}`,
          `  Enabled: ${job.enabled}`,
          `  Next run: ${job.enabled ? formatLocalDate(job.nextRunAt) : 'n/a (disabled)'}`,
        ].join('\n'),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error updating schedule: ${msg}`, isError: true };
    }
  }
}

registerTool(new ScheduleUpdateTool());
