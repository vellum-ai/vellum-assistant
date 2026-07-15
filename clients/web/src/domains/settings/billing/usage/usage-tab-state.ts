import { ApiError } from "@/utils/api-errors";
import { LLM_USAGE_DIMENSION_LABELS } from "@/utils/llm-dimension";
import { resolveUsageRangeWindow } from "@/utils/usage-window";
import type {
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesBucket,
  UsageSeriesGroupBy,
  UsageTimeRange,
} from "./usage-types";

export const DEFAULT_USAGE_RANGE: UsageTimeRange = "7d";
export const DEFAULT_USAGE_GROUP_BY: UsageGroupBy = "task";
export const FALLBACK_USAGE_GROUP_BY: UsageGroupBy = "model";
const UNSUPPORTED_GROUP_BY_STATUSES = new Set([400, 404, 422]);
const MAX_RETRY_COUNT = 3;
const USAGE_TIME_RANGES = new Set<UsageTimeRange>([
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "all",
]);
const USAGE_GROUP_BYS = new Set<UsageGroupBy>([
  "actor",
  "provider",
  "model",
  "conversation",
  "task",
  "profile",
  "schedule",
]);

export const USAGE_GROUP_LABELS: Record<UsageGroupBy, string> = {
  task: LLM_USAGE_DIMENSION_LABELS.task,
  profile: LLM_USAGE_DIMENSION_LABELS.profile,
  model: LLM_USAGE_DIMENSION_LABELS.model,
  provider: "Provider",
  actor: "Actor",
  conversation: "Conversation",
  schedule: "Schedule",
};

export const USAGE_GROUP_BY_OPTIONS: Array<{
  value: UsageGroupBy;
  label: string;
}> = [
  { value: "task", label: USAGE_GROUP_LABELS.task },
  { value: "profile", label: USAGE_GROUP_LABELS.profile },
  { value: "model", label: USAGE_GROUP_LABELS.model },
  { value: "provider", label: USAGE_GROUP_LABELS.provider },
  { value: "schedule", label: USAGE_GROUP_LABELS.schedule },
  { value: "conversation", label: USAGE_GROUP_LABELS.conversation },
];

export interface UsageUrlState {
  range: UsageTimeRange;
  groupBy: UsageGroupBy;
  scheduleId: string | undefined;
}

export interface UsageSearchParamsUpdate {
  range?: UsageTimeRange;
  groupBy?: UsageGroupBy;
  scheduleId?: string | null;
}

export function readUsageUrlState(
  searchParams: URLSearchParams,
): UsageUrlState {
  const range = searchParams.get("range");
  const rawGroupBy = searchParams.get("groupBy");
  const groupBy = isUsageGroupBy(rawGroupBy)
    ? rawGroupBy
    : DEFAULT_USAGE_GROUP_BY;
  return {
    range: isUsageTimeRange(range) ? range : DEFAULT_USAGE_RANGE,
    groupBy,
    scheduleId:
      groupBy === "schedule" ? readUsageScheduleId(searchParams) : undefined,
  };
}

export function readUsageScheduleId(
  searchParams: URLSearchParams,
): string | undefined {
  const scheduleId = searchParams.get("scheduleId");
  if (!scheduleId || scheduleId.trim().length === 0) {
    return undefined;
  }
  return scheduleId;
}

export function buildUsageSearchParams(
  searchParams: URLSearchParams,
  update: UsageSearchParamsUpdate,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);

  if (update.range !== undefined) {
    next.set("range", update.range);
  }
  if (update.groupBy !== undefined) {
    next.set("groupBy", update.groupBy);
  }
  if (update.scheduleId !== undefined) {
    if (update.scheduleId === null || update.scheduleId.trim().length === 0) {
      next.delete("scheduleId");
    } else {
      next.set("scheduleId", update.scheduleId);
    }
  }
  if (next.get("groupBy") !== "schedule") {
    next.delete("scheduleId");
  }

  return next;
}

function isUsageTimeRange(value: string | null): value is UsageTimeRange {
  return value != null && USAGE_TIME_RANGES.has(value as UsageTimeRange);
}

function isUsageGroupBy(value: string | null): value is UsageGroupBy {
  return value != null && USAGE_GROUP_BYS.has(value as UsageGroupBy);
}

export function shouldFetchUsageSeries(
  groupBy: UsageGroupBy,
): groupBy is UsageSeriesGroupBy {
  return groupBy !== "conversation";
}

export function shouldFallbackUsageGroupBy(
  groupBy: UsageGroupBy,
  error: unknown,
): boolean {
  if (groupBy !== "task" && groupBy !== "profile") {
    return false;
  }

  return isUnsupportedUsageGroupByError(error);
}

export function shouldRetryUsageGroupQuery(
  failureCount: number,
  error: unknown,
): boolean {
  return (
    !isUnsupportedUsageGroupByError(error) && failureCount < MAX_RETRY_COUNT
  );
}

function isUnsupportedUsageGroupByError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    UNSUPPORTED_GROUP_BY_STATUSES.has(error.status)
  );
}

export function trendTitle(
  rangeGranularity: UsageGranularity,
  groupBy?: UsageGroupBy,
): string {
  const prefix =
    rangeGranularity === "hourly" ? "Hourly Trend" : "Daily Trend";
  if (!groupBy || groupBy === "conversation") {
    return prefix;
  }

  return `${prefix} by ${USAGE_GROUP_LABELS[groupBy]}`;
}

export function resolveEffectiveUsageGranularity({
  requestedGranularity,
  isLoading,
  buckets,
}: {
  requestedGranularity: UsageGranularity;
  isLoading: boolean;
  buckets:
    | readonly Pick<UsageSeriesBucket, "bucketId" | "date">[]
    | undefined;
}): UsageGranularity {
  if (requestedGranularity !== "hourly") {
    return "daily";
  }

  if (isLoading || !buckets || buckets.length === 0) {
    return "hourly";
  }

  return buckets.some(isHourlyBucket) ? "hourly" : "daily";
}

function isHourlyBucket(
  bucket: Pick<UsageSeriesBucket, "bucketId" | "date">,
) {
  return bucket.bucketId.includes("|") || isHourlyDate(bucket.date);
}

function isHourlyDate(date: string) {
  return /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):00$/.test(date);
}

/**
 * Resolve the `{ from, to }` epoch-ms window for a usage range, with calendar
 * day boundaries computed in the effective `tz` so they stay aligned with the
 * `tz` sent to the backend (which buckets by that zone). `to` is the current
 * instant; `from` is zone-local midnight of the range's first calendar day.
 */
export function resolveRangeWindow(
  range: UsageTimeRange,
  tz: string,
  now: Date | number = Date.now(),
): {
  from: number;
  to: number;
} {
  return resolveUsageRangeWindow(range, tz, now);
}

export function resolveUsageGranularity(
  range: UsageTimeRange,
): UsageGranularity {
  // Single-calendar-day ranges read best at hourly resolution.
  return range === "today" || range === "yesterday" ? "hourly" : "daily";
}
