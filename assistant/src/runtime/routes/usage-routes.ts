/**
 * Route handlers for usage and cost summary endpoints.
 *
 * GET /v1/usage/totals?from=&to=              — aggregate totals for a time range
 * GET /v1/usage/daily?from=&to=               — per-day buckets for a time range
 * GET /v1/usage/breakdown?from=&to=&groupBy=  — grouped breakdown (actor, provider, model)
 */

import { z } from "zod";

import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageHourBuckets,
  getUsageTotals,
} from "../../memory/llm-usage-store.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const VALID_GROUP_BY = new Set(["actor", "provider", "model", "conversation"]);

/**
 * Parse and validate the `from` and `to` epoch-millis query parameters.
 * Returns the parsed range or an error Response.
 */
function parseTimeRange(url: URL): { from: number; to: number } | Response {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  if (!fromRaw || !toRaw) {
    return httpError(
      "BAD_REQUEST",
      'Missing required query parameters: "from" and "to" (epoch milliseconds)',
      400,
    );
  }

  const from = Number(fromRaw);
  const to = Number(toRaw);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return httpError(
      "BAD_REQUEST",
      '"from" and "to" must be valid numbers (epoch milliseconds)',
      400,
    );
  }

  if (from > to) {
    return httpError(
      "BAD_REQUEST",
      '"from" must be less than or equal to "to"',
      400,
    );
  }

  return { from, to };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function usageRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "usage/totals",
      method: "GET",
      summary: "Get usage totals",
      description: "Return aggregate usage totals for a time range.",
      tags: ["usage"],
      queryParams: [
        {
          name: "from",
          schema: { type: "integer" },
          description: "Start epoch millis (required)",
        },
        {
          name: "to",
          schema: { type: "integer" },
          description: "End epoch millis (required)",
        },
      ],
      handler: ({ url }) => {
        const range = parseTimeRange(url);
        if (range instanceof Response) return range;
        const totals = getUsageTotals(range);
        return Response.json(totals);
      },
    },
    {
      endpoint: "usage/daily",
      method: "GET",
      summary: "Get daily usage",
      description: "Return per-day usage buckets for a time range.",
      tags: ["usage"],
      queryParams: [
        {
          name: "from",
          schema: { type: "integer" },
          description: "Start epoch millis (required)",
        },
        {
          name: "to",
          schema: { type: "integer" },
          description: "End epoch millis (required)",
        },
        {
          name: "granularity",
          schema: { type: "string", enum: ["daily", "hourly"] },
          description: 'Bucket granularity: "daily" (default) or "hourly"',
        },
      ],
      responseBody: z.object({
        buckets: z.array(z.unknown()).describe("Usage bucket objects"),
      }),
      handler: ({ url }) => {
        const range = parseTimeRange(url);
        if (range instanceof Response) return range;
        const granularity = url.searchParams.get("granularity") ?? "daily";
        if (granularity !== "daily" && granularity !== "hourly") {
          return httpError(
            "BAD_REQUEST",
            `Invalid "granularity" value: "${granularity}". Must be one of: daily, hourly`,
            400,
          );
        }
        const buckets =
          granularity === "hourly"
            ? getUsageHourBuckets(range)
            : getUsageDayBuckets(range);
        return Response.json({ buckets });
      },
    },
    {
      endpoint: "usage/breakdown",
      method: "GET",
      summary: "Get usage breakdown",
      description:
        "Return grouped usage breakdown (by actor, provider, model, or conversation).",
      tags: ["usage"],
      queryParams: [
        {
          name: "from",
          schema: { type: "integer" },
          description: "Start epoch millis (required)",
        },
        {
          name: "to",
          schema: { type: "integer" },
          description: "End epoch millis (required)",
        },
        {
          name: "groupBy",
          schema: { type: "string" },
          description:
            "Group by: actor, provider, model, or conversation (required)",
        },
      ],
      responseBody: z.object({
        breakdown: z.array(z.unknown()).describe("Grouped usage entries"),
      }),
      handler: ({ url }) => {
        const range = parseTimeRange(url);
        if (range instanceof Response) return range;

        const groupBy = url.searchParams.get("groupBy");
        if (!groupBy) {
          return httpError(
            "BAD_REQUEST",
            'Missing required query parameter: "groupBy" (one of: actor, provider, model, conversation)',
            400,
          );
        }
        if (!VALID_GROUP_BY.has(groupBy)) {
          return httpError(
            "BAD_REQUEST",
            `Invalid "groupBy" value: "${groupBy}". Must be one of: actor, provider, model, conversation`,
            400,
          );
        }

        const breakdown = getUsageGroupBreakdown(
          range,
          groupBy as "actor" | "provider" | "model" | "conversation",
        );
        return Response.json({ breakdown });
      },
    },
  ];
}
