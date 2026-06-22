export interface ScheduleAttributionFilter {
  scheduleId?: string;
}

export type ScheduleAttributionSqlParam = string | number;

export interface ScheduleAttributionSqlFragment {
  sql: string;
  params: ScheduleAttributionSqlParam[];
}

export function normalizeScheduleAttributionFilter(
  filter?: ScheduleAttributionFilter,
): ScheduleAttributionFilter {
  const scheduleId = filter?.scheduleId?.trim();
  return scheduleId ? { scheduleId } : {};
}

function usageColumn(column: string, eventAlias: string): string {
  return `${eventAlias}.${column}`;
}

function buildScheduleRunWindowPredicate({
  eventAlias,
  runAlias,
  filter,
}: {
  eventAlias: string;
  runAlias: string;
  filter?: ScheduleAttributionFilter;
}): string {
  const normalized = normalizeScheduleAttributionFilter(filter);
  const scheduleClause = normalized.scheduleId
    ? `${runAlias}.job_id = ? AND `
    : "";
  return `${scheduleClause}${runAlias}.conversation_id = ${usageColumn(
    "conversation_id",
    eventAlias,
  )}
    AND ${usageColumn("created_at", eventAlias)} >= ${runAlias}.started_at
    AND ${usageColumn("created_at", eventAlias)} <= COALESCE(${runAlias}.finished_at, ?)`;
}

function buildScheduleRunWindowParams(
  filter: ScheduleAttributionFilter | undefined,
  now: number,
): ScheduleAttributionSqlParam[] {
  const normalized = normalizeScheduleAttributionFilter(filter);
  return normalized.scheduleId ? [normalized.scheduleId, now] : [now];
}

export function buildScheduleRunWindowExists({
  eventAlias,
  filter,
  now,
  runAlias = "schedule_filter_runs",
}: {
  eventAlias: string;
  filter?: ScheduleAttributionFilter;
  now: number;
  runAlias?: string;
}): ScheduleAttributionSqlFragment {
  return {
    sql: `EXISTS (
      SELECT 1
      FROM cron_runs ${runAlias}
      WHERE ${buildScheduleRunWindowPredicate({
        eventAlias,
        runAlias,
        filter,
      })}
    )`,
    params: buildScheduleRunWindowParams(filter, now),
  };
}

export function buildScheduleAttributionSubquery({
  eventAlias,
  filter,
  now,
  selectExpression,
  runAlias = "schedule_attr_runs",
}: {
  eventAlias: string;
  filter?: ScheduleAttributionFilter;
  now: number;
  selectExpression: string;
  runAlias?: string;
}): ScheduleAttributionSqlFragment {
  return {
    sql: `(
    SELECT ${selectExpression}
    FROM cron_runs ${runAlias}
    WHERE ${buildScheduleRunWindowPredicate({
      eventAlias,
      runAlias,
      filter,
    })}
    ORDER BY ${runAlias}.started_at DESC, ${runAlias}.id DESC
    LIMIT 1
  )`,
    params: buildScheduleRunWindowParams(filter, now),
  };
}
