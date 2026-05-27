import { LLM_USAGE_DIMENSION_LABELS } from "@/utils/llm-dimension";
import { UsageRequestError } from "./usage-api";
import type {
  UsageGranularity,
  UsageGroupBy,
  UsageSeriesBucket,
  UsageSeriesGroupBy,
  UsageTimeRange,
} from "./usage-types";

export const DEFAULT_USAGE_GROUP_BY: UsageGroupBy = "task";
export const FALLBACK_USAGE_GROUP_BY: UsageGroupBy = "model";
const UNSUPPORTED_GROUP_BY_STATUSES = new Set([400, 404, 422]);
const MAX_RETRY_COUNT = 3;

export const USAGE_GROUP_LABELS: Record<UsageGroupBy, string> = {
  task: LLM_USAGE_DIMENSION_LABELS.task,
  profile: LLM_USAGE_DIMENSION_LABELS.profile,
  model: LLM_USAGE_DIMENSION_LABELS.model,
  provider: "Provider",
  actor: "Actor",
  conversation: "Conversation",
};

export const USAGE_GROUP_BY_OPTIONS: Array<{
  value: UsageGroupBy;
  label: string;
}> = [
  { value: "task", label: USAGE_GROUP_LABELS.task },
  { value: "profile", label: USAGE_GROUP_LABELS.profile },
  { value: "model", label: USAGE_GROUP_LABELS.model },
  { value: "provider", label: USAGE_GROUP_LABELS.provider },
  { value: "conversation", label: USAGE_GROUP_LABELS.conversation },
];

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
    error instanceof UsageRequestError &&
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

const RANGE_START_DAY_OFFSETS: Record<Exclude<UsageTimeRange, "all">, number> =
  {
    today: 0,
    "7d": 6,
    "30d": 29,
    "90d": 89,
  };

export function resolveRangeWindow(
  range: UsageTimeRange,
  now: Date | number = Date.now(),
): {
  from: number;
  to: number;
} {
  const to = typeof now === "number" ? now : now.getTime();
  if (range === "all") {
    return { from: 0, to };
  }
  const localNow = new Date(to);
  const dayOffset = RANGE_START_DAY_OFFSETS[range];
  const from = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate() - dayOffset,
  ).getTime();
  return { from, to };
}

export function resolveUsageGranularity(
  range: UsageTimeRange,
): UsageGranularity {
  return range === "today" ? "hourly" : "daily";
}
