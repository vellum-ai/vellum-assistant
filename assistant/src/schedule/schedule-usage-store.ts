import { rawAll } from "../persistence/raw-query.js";
import { buildScheduleAttributionSubquery } from "../persistence/schedule-attribution-sql.js";

export interface ScheduleUsageSummary {
  scheduleId: string;
  runCount: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

interface ScheduleUsageSummaryRow {
  schedule_id: string;
  run_count: number;
  total_estimated_cost_usd: number | null;
  event_count: number | null;
}

export function getScheduleUsageSummaries({
  from,
  to,
}: {
  from: number;
  to: number;
}): ScheduleUsageSummary[] {
  const now = Date.now();
  const scheduleAttribution = buildScheduleAttributionSubquery({
    eventAlias: "e",
    now,
    selectExpression: "schedule_attr_runs.job_id",
  });
  const rows = rawAll<ScheduleUsageSummaryRow>(
    "scheduleUsage:getSummaries",
    /*sql*/ `
    WITH run_counts AS (
      SELECT
        job_id AS schedule_id,
        COUNT(*) AS run_count
      FROM cron_runs
      WHERE started_at >= ?
        AND started_at <= ?
      GROUP BY job_id
    ),
    attributed_usage AS (
      SELECT
        e.estimated_cost_usd,
        COALESCE(e.llm_call_count, 1) AS event_count,
        ${scheduleAttribution.sql} AS schedule_id
      FROM llm_usage_events e
      WHERE e.created_at >= ?
        AND e.created_at <= ?
    ),
    usage_totals AS (
      SELECT
        schedule_id,
        COALESCE(SUM(estimated_cost_usd), 0) AS total_estimated_cost_usd,
        COALESCE(SUM(event_count), 0) AS event_count
      FROM attributed_usage
      WHERE schedule_id IS NOT NULL
      GROUP BY schedule_id
    )
    SELECT
      cron_jobs.id AS schedule_id,
      COALESCE(run_counts.run_count, 0) AS run_count,
      COALESCE(usage_totals.total_estimated_cost_usd, 0) AS total_estimated_cost_usd,
      COALESCE(usage_totals.event_count, 0) AS event_count
    FROM cron_jobs
    LEFT JOIN run_counts ON run_counts.schedule_id = cron_jobs.id
    LEFT JOIN usage_totals ON usage_totals.schedule_id = cron_jobs.id
    ORDER BY cron_jobs.created_at ASC, cron_jobs.id ASC
    `,
    from,
    to,
    ...scheduleAttribution.params,
    from,
    to,
  );

  return rows.map((row) => ({
    scheduleId: row.schedule_id,
    runCount: row.run_count,
    totalEstimatedCostUsd: row.total_estimated_cost_usd ?? 0,
    eventCount: row.event_count ?? 0,
  }));
}
