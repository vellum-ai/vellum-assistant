import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { deleteCronJob, getCronJob } from '../../cron/cron-store.js';

class CronDeleteTool implements Tool {
  name = 'cron_delete';
  description = 'Delete a cron job and all its run history';
  category = 'cron';
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'The ID of the cron job to delete',
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

    // Fetch the job first for the confirmation message
    const job = getCronJob(jobId);
    if (!job) {
      return { content: `Error: Cron job not found: ${jobId}`, isError: true };
    }

    const deleted = deleteCronJob(jobId);
    if (!deleted) {
      return { content: `Error: Failed to delete cron job: ${jobId}`, isError: true };
    }

    return {
      content: `Cron job deleted: "${job.name}" (${jobId})`,
      isError: false,
    };
  }
}

registerTool(new CronDeleteTool());
