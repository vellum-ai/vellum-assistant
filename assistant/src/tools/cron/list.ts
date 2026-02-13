import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { listCronJobs, getCronJob, getCronRuns, formatLocalDate } from '../../cron/cron-store.js';

class CronListTool implements Tool {
  name = 'cron_list';
  description = 'List cron jobs, or show details and recent runs for a specific job';
  category = 'cron';
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
      const job = getCronJob(jobId);
      if (!job) {
        return { content: `Error: Cron job not found: ${jobId}`, isError: true };
      }

      const runs = getCronRuns(jobId, 5);
      const lines = [
        `Cron Job: ${job.name}`,
        `  ID: ${job.id}`,
        `  Schedule: ${job.cronExpression}${job.timezone ? ` (${job.timezone})` : ''}`,
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
    const jobs = listCronJobs({ enabledOnly });
    if (jobs.length === 0) {
      return { content: 'No cron jobs found.', isError: false };
    }

    const lines = [`Cron Jobs (${jobs.length}):`];
    for (const job of jobs) {
      const status = job.enabled ? 'enabled' : 'disabled';
      const next = job.enabled ? formatLocalDate(job.nextRunAt) : 'n/a';
      lines.push(`  - [${status}] ${job.name} (${job.cronExpression}) — next: ${next} — id: ${job.id}`);
    }

    return { content: lines.join('\n'), isError: false };
  }
}

registerTool(new CronListTool());
