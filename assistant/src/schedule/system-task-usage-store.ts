import { MEMORY_RETROSPECTIVE_SOURCES } from "../memory/memory-retrospective-constants.js";
import { rawAll } from "../memory/raw-query.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../memory/v2/constants.js";
import type { ScheduleUsageSummary } from "./schedule-usage-store.js";

const SYSTEM_TASK_IDS = {
  heartbeat: "system-heartbeat",
  consolidation: "system-consolidation",
  retrospective: "system-memory-retrospective",
} as const;

interface UsageSummaryRow {
  schedule_id: string;
  run_count: number;
  total_estimated_cost_usd: number | null;
  event_count: number | null;
}

interface UsageRange {
  from: number;
  to: number;
}

export function getSystemTaskUsageSummaries(
  range: UsageRange,
): ScheduleUsageSummary[] {
  const summaries = [
    getHeartbeatUsageSummary(range),
    getConversationTaskUsageSummary(
      SYSTEM_TASK_IDS.consolidation,
      [MEMORY_V2_CONSOLIDATION_SOURCE],
      range,
    ),
    getConversationTaskUsageSummary(
      SYSTEM_TASK_IDS.retrospective,
      [...MEMORY_RETROSPECTIVE_SOURCES],
      range,
    ),
  ];
  return summaries.filter((summary) => !isEmptySummary(summary));
}

function getHeartbeatUsageSummary({
  from,
  to,
}: UsageRange): ScheduleUsageSummary {
  const now = Date.now();
  const rows = rawAll<UsageSummaryRow>(
    /*sql*/ `
    WITH countable_runs AS (
      SELECT
        conversation_id,
        COALESCE(started_at, scheduled_for) AS started_at,
        COALESCE(finished_at, ?) AS finished_at
      FROM heartbeat_runs
      WHERE status IN ('ok', 'error', 'timeout')
        AND scheduled_for >= ?
        AND scheduled_for <= ?
    ),
    usage_totals AS (
      SELECT
        COALESCE(SUM(e.estimated_cost_usd), 0) AS total_estimated_cost_usd,
        COALESCE(SUM(COALESCE(e.llm_call_count, 1)), 0) AS event_count
      FROM llm_usage_events e
      JOIN countable_runs r ON r.conversation_id = e.conversation_id
      WHERE e.created_at >= CASE WHEN r.started_at > ? THEN r.started_at ELSE ? END
        AND e.created_at <= CASE WHEN r.finished_at < ? THEN r.finished_at ELSE ? END
    )
    SELECT
      ? AS schedule_id,
      (SELECT COUNT(*) FROM countable_runs) AS run_count,
      usage_totals.total_estimated_cost_usd,
      usage_totals.event_count
    FROM usage_totals
    `,
    now,
    from,
    to,
    from,
    from,
    to,
    to,
    SYSTEM_TASK_IDS.heartbeat,
  );
  return rowToSummary(rows[0], SYSTEM_TASK_IDS.heartbeat);
}

function getConversationTaskUsageSummary(
  scheduleId: string,
  sources: readonly string[],
  { from, to }: UsageRange,
): ScheduleUsageSummary {
  if (sources.length === 0) return rowToSummary(undefined, scheduleId);

  const sourcePlaceholders = sources.map(() => "?").join(", ");
  const rows = rawAll<UsageSummaryRow>(
    /*sql*/ `
    WITH candidate_conversations AS (
      SELECT id, created_at
      FROM conversations
      WHERE source IN (${sourcePlaceholders})
        AND created_at >= ?
        AND created_at <= ?
    ),
    completed_runs AS (
      SELECT
        c.id AS conversation_id,
        c.created_at AS started_at,
        MAX(m.created_at) AS finished_at
      FROM candidate_conversations c
      JOIN messages m
        ON m.conversation_id = c.id
       AND m.role = 'assistant'
       AND m.created_at >= c.created_at
      GROUP BY c.id, c.created_at
    ),
    usage_totals AS (
      SELECT
        COALESCE(SUM(e.estimated_cost_usd), 0) AS total_estimated_cost_usd,
        COALESCE(SUM(COALESCE(e.llm_call_count, 1)), 0) AS event_count
      FROM llm_usage_events e
      JOIN completed_runs r ON r.conversation_id = e.conversation_id
      WHERE e.created_at >= CASE WHEN r.started_at > ? THEN r.started_at ELSE ? END
        AND e.created_at <= CASE WHEN r.finished_at < ? THEN r.finished_at ELSE ? END
    )
    SELECT
      ? AS schedule_id,
      (SELECT COUNT(*) FROM completed_runs) AS run_count,
      usage_totals.total_estimated_cost_usd,
      usage_totals.event_count
    FROM usage_totals
    `,
    ...sources,
    from,
    to,
    from,
    from,
    to,
    to,
    scheduleId,
  );
  return rowToSummary(rows[0], scheduleId);
}

function rowToSummary(
  row: UsageSummaryRow | undefined,
  scheduleId: string,
): ScheduleUsageSummary {
  return {
    scheduleId,
    runCount: row?.run_count ?? 0,
    totalEstimatedCostUsd: row?.total_estimated_cost_usd ?? 0,
    eventCount: row?.event_count ?? 0,
  };
}

function isEmptySummary(summary: ScheduleUsageSummary): boolean {
  return (
    summary.runCount === 0 &&
    summary.totalEstimatedCostUsd === 0 &&
    summary.eventCount === 0
  );
}
