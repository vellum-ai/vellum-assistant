import { hasSetConstructs } from "../../schedule/recurrence-engine.js";
import {
  describeCronExpression,
  formatLocalDate,
  getSchedule,
  getScheduleRuns,
  listSchedules,
} from "../../schedule/schedule-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function describeSchedule(job: {
  syntax: string;
  expression: string | null;
  cronExpression: string | null;
}): string {
  if (job.expression == null) return "One-time";
  if (job.syntax === "rrule") {
    const label = hasSetConstructs(job.expression) ? "[RRULE set] " : "";
    return `${label}${job.expression}`;
  }
  return describeCronExpression(job.cronExpression);
}

function isOneShot(job: { expression: string | null }): boolean {
  return job.expression == null;
}

export async function executeScheduleList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const jobId = input.job_id as string | undefined;
  const enabledOnly = (input.enabled_only as boolean) ?? false;

  // Detail mode for a specific job
  if (jobId) {
    const job = getSchedule(jobId);
    if (!job) {
      return { content: `Error: Schedule not found: ${jobId}`, isError: true };
    }

    const oneShot = isOneShot(job);

    const runs = getScheduleRuns(jobId, 5);
    const lines = [
      `Schedule: ${job.name}`,
      `  ID: ${job.id}`,
      `  Type: ${oneShot ? "one-shot" : "recurring"}`,
      `  Mode: ${job.mode}`,
      `  Status: ${job.status}`,
    ];

    if (oneShot) {
      lines.push(`  Fire at: ${formatLocalDate(job.nextRunAt)}`);
    } else {
      lines.push(
        `  Syntax: ${job.syntax}`,
        `  Expression: ${job.expression ?? "(one-time)"}`,
        `  Schedule: ${describeSchedule(job)}${
          job.timezone ? ` (${job.timezone})` : ""
        }`,
      );
    }

    lines.push(`  Enabled: ${job.enabled}`, `  Message: ${job.message}`);

    if (!oneShot) {
      lines.push(`  Next run: ${formatLocalDate(job.nextRunAt)}`);
    }

    lines.push(
      `  Last run: ${job.lastRunAt ? formatLocalDate(job.lastRunAt) : "never"}`,
      `  Last status: ${job.lastStatus ?? "n/a"}`,
      `  Retry count: ${job.retryCount}`,
      `  Created: ${formatLocalDate(job.createdAt)}`,
    );

    // Show routing intent in detail view when not the default
    if (job.routingIntent !== "all_channels") {
      lines.push(`  Routing: ${job.routingIntent}`);
    }

    if (runs.length > 0) {
      lines.push("", `Recent runs (${runs.length}):`);
      for (const run of runs) {
        const dur = run.durationMs != null ? `${run.durationMs}ms` : "n/a";
        lines.push(
          `  - ${run.status} at ${formatLocalDate(run.startedAt)} (${dur})${
            run.error ? ` error: ${run.error}` : ""
          }`,
        );
      }
    } else {
      lines.push("", "No runs yet.");
    }

    return { content: lines.join("\n"), isError: false };
  }

  // List mode
  const jobs = listSchedules({ enabledOnly });
  if (jobs.length === 0) {
    return { content: "No schedules found.", isError: false };
  }

  const lines = [`Schedules (${jobs.length}):`];
  for (const job of jobs) {
    const status = job.enabled ? "enabled" : "disabled";
    const oneShot = isOneShot(job);

    if (oneShot) {
      const fireTime = formatLocalDate(job.nextRunAt);
      lines.push(
        `  - [${status}] ${job.name} (id: ${job.id}) (one-shot, ${job.mode}) - fire at: ${fireTime} [${job.status}]`,
      );
    } else {
      const next = job.enabled ? formatLocalDate(job.nextRunAt) : "n/a";
      lines.push(
        `  - [${status}] ${job.name} (id: ${job.id}) ([${
          job.syntax
        }] ${describeSchedule(job)}, ${job.mode}) - next: ${next}`,
      );
    }
  }

  return { content: lines.join("\n"), isError: false };
}
