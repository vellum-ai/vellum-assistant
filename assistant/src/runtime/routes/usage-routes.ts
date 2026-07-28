/**
 * Route handlers for usage and cost summary endpoints.
 *
 * GET /v1/usage/totals?from=&to=&scheduleId=  — aggregate totals for a time range
 * GET /v1/usage/daily?from=&to=&scheduleId=   — per-day buckets for a time range
 * GET /v1/usage/breakdown?from=&to=&groupBy=&scheduleId=  — grouped breakdown
 * GET /v1/usage/series?from=&to=&granularity=&groupBy=&scheduleId= — grouped time-series buckets
 */

import { z } from "zod";

import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageGroupedSeries,
  getUsageHourBuckets,
  getUsageTotals,
  USAGE_SERIES_GROUP_BY_DIMENSIONS,
  type UsageAggregationFilter,
  type UsageGranularity,
} from "../../persistence/llm-usage-store.js";
import { validateTimezone } from "../../persistence/usage-buckets.js";
import {
  type GroupByDimension,
  USAGE_GROUP_BY_DIMENSIONS,
} from "../../persistence/usage-types.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { parseEpochMillisRange } from "./epoch-millis-range.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const VALID_GROUP_BY = new Set<string>(USAGE_GROUP_BY_DIMENSIONS);
const VALID_SERIES_GROUP_BY = new Set<string>(USAGE_SERIES_GROUP_BY_DIMENSIONS);
const GROUP_BY_DESCRIPTION = USAGE_GROUP_BY_DIMENSIONS.join(", ");
const SERIES_GROUP_BY_DESCRIPTION = USAGE_SERIES_GROUP_BY_DIMENSIONS.join(", ");
const SCHEDULE_ID_FILTER_DESCRIPTION =
  "Optional schedule id. When set, usage is attributed by cron run windows for that schedule.";

const usageTotalsSchema = z.object({
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheCreationTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalEstimatedCostUsd: z.number(),
  eventCount: z.number(),
  pricedEventCount: z.number(),
  unpricedEventCount: z.number(),
});

const usageDayBucketSchema = z.object({
  bucketId: z.string(),
  date: z.string(),
  displayLabel: z.string().optional(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalEstimatedCostUsd: z.number(),
  eventCount: z.number(),
});

const usageGroupBreakdownSchema = z.object({
  group: z.string(),
  groupId: z.string().nullable(),
  groupKey: z.string().nullable().optional(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheCreationTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalEstimatedCostUsd: z.number(),
  eventCount: z.number(),
  // Distinct conversation turns; populated only for the conversation grouping,
  // null otherwise (and for the conversation "Other" bucket).
  turnCount: z.number().nullable(),
});

const usageSeriesGroupValueSchema = z.object({
  group: z.string(),
  groupKey: z.string().nullable(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalEstimatedCostUsd: z.number(),
  eventCount: z.number(),
});

const usageSeriesBucketSchema = usageDayBucketSchema.extend({
  groups: z.record(z.string(), usageSeriesGroupValueSchema),
});

function resolveTimezone(queryParams: Record<string, string>): string {
  const tz = queryParams.tz ?? "UTC";
  try {
    validateTimezone(tz);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }
  return tz;
}

function parseUsageAggregationFilter(
  queryParams: Record<string, string>,
): UsageAggregationFilter {
  const scheduleId = queryParams.scheduleId?.trim();
  return scheduleId ? { scheduleId } : {};
}

function handleUsageTotals({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseEpochMillisRange(qp);
  const filter = parseUsageAggregationFilter(qp);
  return getUsageTotals(range, filter);
}

function handleUsageDaily({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseEpochMillisRange(qp);
  const granularity = qp.granularity ?? "daily";
  if (granularity !== "daily" && granularity !== "hourly") {
    throw new BadRequestError(
      `Invalid "granularity" value: "${granularity}". Must be one of: daily, hourly`,
    );
  }
  const tz = resolveTimezone(qp);
  const filter = parseUsageAggregationFilter(qp);
  const buckets =
    granularity === "hourly"
      ? getUsageHourBuckets(range, tz, { fillEmpty: true }, filter)
      : getUsageDayBuckets(range, tz, { fillEmpty: true }, filter);
  return { buckets };
}

function handleUsageBreakdown({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseEpochMillisRange(qp);

  const groupBy = qp.groupBy;
  if (!groupBy) {
    throw new BadRequestError(
      `Missing required query parameter: "groupBy" (one of: ${GROUP_BY_DESCRIPTION})`,
    );
  }
  if (!VALID_GROUP_BY.has(groupBy)) {
    throw new BadRequestError(
      `Invalid "groupBy" value: "${groupBy}". Must be one of: ${GROUP_BY_DESCRIPTION}`,
    );
  }

  const filter = parseUsageAggregationFilter(qp);
  const breakdown = getUsageGroupBreakdown(
    range,
    groupBy as GroupByDimension,
    filter,
  );
  return { breakdown };
}

function handleUsageSeries({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseEpochMillisRange(qp);
  const granularity = qp.granularity ?? "daily";
  if (granularity !== "daily" && granularity !== "hourly") {
    throw new BadRequestError(
      `Invalid "granularity" value: "${granularity}". Must be one of: daily, hourly`,
    );
  }

  const groupBy = qp.groupBy;
  if (!groupBy) {
    throw new BadRequestError(
      `Missing required query parameter: "groupBy" (one of: ${SERIES_GROUP_BY_DESCRIPTION})`,
    );
  }
  if (!VALID_SERIES_GROUP_BY.has(groupBy)) {
    throw new BadRequestError(
      `Invalid "groupBy" value: "${groupBy}". Must be one of: ${SERIES_GROUP_BY_DESCRIPTION}`,
    );
  }

  const tz = resolveTimezone(qp);
  const filter = parseUsageAggregationFilter(qp);
  const buckets = getUsageGroupedSeries(
    range,
    groupBy as Exclude<GroupByDimension, "conversation">,
    granularity as UsageGranularity,
    tz,
    { fillEmpty: true },
    filter,
  );
  return { buckets };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "usage_totals",
    endpoint: "usage/totals",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get usage totals",
    description: "Return aggregate usage totals for a time range.",
    tags: ["usage"],
    queryParams: [
      {
        name: "from",
        type: "integer",
        description: "Start epoch millis (required)",
      },
      {
        name: "to",
        type: "integer",
        description: "End epoch millis (required)",
      },
      {
        name: "scheduleId",
        description: SCHEDULE_ID_FILTER_DESCRIPTION,
      },
    ],
    responseBody: usageTotalsSchema,
    handler: handleUsageTotals,
  },
  {
    operationId: "usage_daily",
    endpoint: "usage/daily",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get daily usage",
    description: "Return per-day usage buckets for a time range.",
    tags: ["usage"],
    queryParams: [
      {
        name: "from",
        type: "integer",
        description: "Start epoch millis (required)",
      },
      {
        name: "to",
        type: "integer",
        description: "End epoch millis (required)",
      },
      {
        name: "granularity",
        schema: { type: "string", enum: ["daily", "hourly"] },
        description: 'Bucket granularity: "daily" (default) or "hourly"',
      },
      {
        name: "tz",
        description:
          'IANA timezone identifier (e.g. "America/Los_Angeles"). Bucket boundaries and display labels are computed in this timezone. Defaults to "UTC" for backwards compatibility.',
      },
      {
        name: "scheduleId",
        description: SCHEDULE_ID_FILTER_DESCRIPTION,
      },
    ],
    responseBody: z.object({
      buckets: z.array(usageDayBucketSchema).describe("Usage bucket objects"),
    }),
    handler: handleUsageDaily,
  },
  {
    operationId: "usage_breakdown",
    endpoint: "usage/breakdown",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get usage breakdown",
    description:
      "Return grouped usage breakdown. Prefer call_site for user-facing task breakdowns; actor is a legacy/internal dimension.",
    tags: ["usage"],
    queryParams: [
      {
        name: "from",
        type: "integer",
        description: "Start epoch millis (required)",
      },
      {
        name: "to",
        type: "integer",
        description: "End epoch millis (required)",
      },
      {
        name: "groupBy",
        description: `Group by: ${GROUP_BY_DESCRIPTION} (required)`,
      },
      {
        name: "scheduleId",
        description: SCHEDULE_ID_FILTER_DESCRIPTION,
      },
    ],
    responseBody: z.object({
      breakdown: z
        .array(usageGroupBreakdownSchema)
        .describe("Grouped usage entries"),
    }),
    handler: handleUsageBreakdown,
  },
  {
    operationId: "usage_series",
    endpoint: "usage/series",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get grouped usage series",
    description:
      "Return usage buckets with per-group values for stacked charts. Prefer call_site for user-facing task stacks.",
    tags: ["usage"],
    queryParams: [
      {
        name: "from",
        type: "integer",
        description: "Start epoch millis (required)",
      },
      {
        name: "to",
        type: "integer",
        description: "End epoch millis (required)",
      },
      {
        name: "granularity",
        schema: { type: "string", enum: ["daily", "hourly"] },
        description: 'Bucket granularity: "daily" (default) or "hourly"',
      },
      {
        name: "groupBy",
        description: `Group by: ${SERIES_GROUP_BY_DESCRIPTION} (required)`,
      },
      {
        name: "tz",
        description:
          'IANA timezone identifier (e.g. "America/Los_Angeles"). Bucket boundaries and display labels are computed in this timezone. Defaults to "UTC".',
      },
      {
        name: "scheduleId",
        description: SCHEDULE_ID_FILTER_DESCRIPTION,
      },
    ],
    responseBody: z.object({
      buckets: z
        .array(usageSeriesBucketSchema)
        .describe("Grouped usage bucket objects"),
    }),
    handler: handleUsageSeries,
  },
];
