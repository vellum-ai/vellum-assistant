/**
 * Route handlers for usage and cost summary endpoints.
 *
 * GET /v1/usage/totals?from=&to=              — aggregate totals for a time range
 * GET /v1/usage/daily?from=&to=               — per-day buckets for a time range
 * GET /v1/usage/breakdown?from=&to=&groupBy=  — grouped breakdown (actor, provider, model, or conversation)
 */

import { z } from "zod";

import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageHourBuckets,
  getUsageTotals,
} from "../../memory/llm-usage-store.js";
import { validateTimezone } from "../../memory/usage-buckets.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const VALID_GROUP_BY = new Set(["actor", "provider", "model", "conversation"]);

function resolveTimezone(queryParams: Record<string, string>): string {
  const tz = queryParams.tz ?? "UTC";
  try {
    validateTimezone(tz);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }
  return tz;
}

function parseTimeRange(queryParams: Record<string, string>): {
  from: number;
  to: number;
} {
  const fromRaw = queryParams.from;
  const toRaw = queryParams.to;

  if (!fromRaw || !toRaw) {
    throw new BadRequestError(
      'Missing required query parameters: "from" and "to" (epoch milliseconds)',
    );
  }

  const from = Number(fromRaw);
  const to = Number(toRaw);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new BadRequestError(
      '"from" and "to" must be valid numbers (epoch milliseconds)',
    );
  }

  if (from > to) {
    throw new BadRequestError('"from" must be less than or equal to "to"');
  }

  return { from, to };
}

function handleUsageTotals({ queryParams }: RouteHandlerArgs) {
  const range = parseTimeRange(queryParams ?? {});
  return getUsageTotals(range);
}

function handleUsageDaily({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseTimeRange(qp);
  const granularity = qp.granularity ?? "daily";
  if (granularity !== "daily" && granularity !== "hourly") {
    throw new BadRequestError(
      `Invalid "granularity" value: "${granularity}". Must be one of: daily, hourly`,
    );
  }
  const tz = resolveTimezone(qp);
  const buckets =
    granularity === "hourly"
      ? getUsageHourBuckets(range, tz, { fillEmpty: true })
      : getUsageDayBuckets(range, tz, { fillEmpty: true });
  return { buckets };
}

function handleUsageBreakdown({ queryParams }: RouteHandlerArgs) {
  const qp = queryParams ?? {};
  const range = parseTimeRange(qp);

  const groupBy = qp.groupBy;
  if (!groupBy) {
    throw new BadRequestError(
      'Missing required query parameter: "groupBy" (one of: actor, provider, model, conversation)',
    );
  }
  if (!VALID_GROUP_BY.has(groupBy)) {
    throw new BadRequestError(
      `Invalid "groupBy" value: "${groupBy}". Must be one of: actor, provider, model, conversation`,
    );
  }

  const breakdown = getUsageGroupBreakdown(
    range,
    groupBy as "actor" | "provider" | "model" | "conversation",
  );
  return { breakdown };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "usage_totals",
    endpoint: "usage/totals",
    method: "GET",
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
    ],
    handler: handleUsageTotals,
  },
  {
    operationId: "usage_daily",
    endpoint: "usage/daily",
    method: "GET",
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
    ],
    responseBody: z.object({
      buckets: z.array(z.unknown()).describe("Usage bucket objects"),
    }),
    handler: handleUsageDaily,
  },
  {
    operationId: "usage_breakdown",
    endpoint: "usage/breakdown",
    method: "GET",
    summary: "Get usage breakdown",
    description:
      "Return grouped usage breakdown (by actor, provider, model, or conversation).",
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
        description:
          "Group by: actor, provider, model, or conversation (required)",
      },
    ],
    responseBody: z.object({
      breakdown: z.array(z.unknown()).describe("Grouped usage entries"),
    }),
    handler: handleUsageBreakdown,
  },
];
