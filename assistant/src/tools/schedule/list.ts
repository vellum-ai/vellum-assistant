import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { listSchedules, getSchedule, getScheduleRuns, formatLocalDate, describeCronExpression } from '../../schedule/schedule-store.js';

class ScheduleListTool implements Tool {
  name = 'schedule_list';
  description = 'List scheduled tasks, or show details and recent runs for a specific task';
  category = 'schedule';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          enabled_only: {
            type: 'boolean',
            description: 'When true, only show enabled jobs. Defaults to false.',
          },
          job_id: {
            type: 'string',
            description: 'If provided, show detailed info and recent runs for this specific job.',
          },
        },
        required: [],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const jobId = input.job_id as string | undefined;
    const enabledOnly = (input.enabled_only as boolean) ?? false;

    // Detail mode for a specific job
    if (jobId) {
      const job = getSchedule(jobId);
      if (!job) {
        return { content: `Error: Schedule not found: ${jobId}`, isError: true };
      }

      const runs = getScheduleRuns(jobId, 5);
      const lines = [
        `Schedule: ${job.name}`,
        `  ID: ${job.id}`,
        `  Schedule: ${describeCronExpression(job.cronExpression)} (${job.cronExpression})${job.timezone ? ` (${job.timezone})` : ''}`,
        `  Enabled: ${job.enabled}`,
        `  Message: ${job.message}`,
        `  Next run: ${formatLocalDate(job.nextRunAt)}`,
        `  Last run: ${job.lastRunAt ? formatLocalDate(job.lastRunAt) : 'never'}`,
        `  Last status: ${job.lastStatus ?? 'n/a'}`,
        `  Retry count: ${job.retryCount}`,
        `  Created: ${formatLocalDate(job.createdAt)}`,
      ];

      if (runs.length > 0) {
        lines.push('', `Recent runs (${runs.length}):`);
        for (const run of runs) {
          const dur = run.durationMs != null ? `${run.durationMs}ms` : 'n/a';
          lines.push(`  - ${run.status} at ${formatLocalDate(run.startedAt)} (${dur})${run.error ? ` error: ${run.error}` : ''}`);
        }
      } else {
        lines.push('', 'No runs yet.');
      }

      return { content: lines.join('\n'), isError: false };
    }

    // List mode
    const jobs = listSchedules({ enabledOnly });
    if (jobs.length === 0) {
      return { content: 'No schedules found.', isError: false };
    }

    const lines = [`Schedules (${jobs.length}):`];
    for (const job of jobs) {
      const status = job.enabled ? 'enabled' : 'disabled';
      const next = job.enabled ? formatLocalDate(job.nextRunAt) : 'n/a';
      lines.push(`  - [${status}] ${job.name} (${describeCronExpression(job.cronExpression)}) — next: ${next} — id: ${job.id}`);
    }

    return { content: lines.join('\n'), isError: false };
  }
}

registerTool(new ScheduleListTool());
