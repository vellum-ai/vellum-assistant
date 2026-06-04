import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getUsageCostForConversationWindow,
  recordUsageEvent,
} from "../memory/llm-usage-store.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/usage-routes.js";

initializeDb();

function clearUsageEvents() {
  getSqlite().run("DELETE FROM cron_runs");
  getSqlite().run("DELETE FROM cron_jobs");
  getSqlite().run("DELETE FROM llm_usage_events");
}

// Build a dispatch helper that calls handlers via the transport-agnostic pattern
function dispatch(method: string, path: string) {
  const url = new URL(`http://localhost/v1/${path}`);
  const endpoint = `usage/${url.pathname.split("/v1/usage/")[1]?.split("?")[0]}`;
  const route = ROUTES.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`No route for ${method} /v1/${path}`);

  const queryParams: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    queryParams[k] = v;
  }

  return route.handler({ queryParams });
}

// ---------------------------------------------------------------------------
// Seed data helper
// ---------------------------------------------------------------------------

function seedEvents() {
  const day1 = new Date("2025-01-15T10:00:00Z").getTime();
  const day2 = new Date("2025-01-16T14:00:00Z").getTime();

  // Two events on day 1, one on day 2
  recordUsageEvent(
    {
      conversationId: "conv-1",
      runId: "run-1",
      requestId: "req-1",
      actor: "main_agent",
      callSite: "mainAgent",
      inferenceProfile: "balanced",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 850,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 100,
      rawUsage: null,
    },
    { estimatedCostUsd: 0.005, pricingStatus: "priced" },
  );
  // Backdate the first event
  getSqlite().run(
    "UPDATE llm_usage_events SET created_at = ? WHERE request_id = 'req-1'",
    [day1],
  );

  recordUsageEvent(
    {
      conversationId: "conv-1",
      runId: "run-1",
      requestId: "req-2",
      actor: "context_compactor",
      callSite: "compactionAgent",
      inferenceProfile: "fast",
      provider: "anthropic",
      model: "claude-haiku-3",
      inputTokens: 500,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      rawUsage: null,
    },
    { estimatedCostUsd: 0.001, pricingStatus: "priced" },
  );
  getSqlite().run(
    "UPDATE llm_usage_events SET created_at = ? WHERE request_id = 'req-2'",
    [day1 + 3600_000],
  );

  recordUsageEvent(
    {
      conversationId: "conv-2",
      runId: "run-2",
      requestId: "req-3",
      actor: "main_agent",
      callSite: null,
      inferenceProfile: null,
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 2000,
      outputTokens: 400,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      rawUsage: null,
    },
    { estimatedCostUsd: 0, pricingStatus: "unpriced" },
  );
  getSqlite().run(
    "UPDATE llm_usage_events SET created_at = ? WHERE request_id = 'req-3'",
    [day2],
  );

  return { day1, day2 };
}

function recordCostAt(
  conversationId: string,
  requestId: string,
  createdAt: number,
  estimatedCostUsd: number,
) {
  recordUsageEvent(
    {
      conversationId,
      runId: null,
      requestId,
      actor: "main_agent",
      callSite: "mainAgent",
      inferenceProfile: "balanced",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      rawUsage: null,
    },
    { estimatedCostUsd, pricingStatus: "priced" },
  );
  getSqlite().run(
    "UPDATE llm_usage_events SET created_at = ? WHERE request_id = ?",
    [createdAt, requestId],
  );
}

function insertScheduleJob(id: string, name: string): void {
  const now = new Date("2026-01-01T00:00:00Z").getTime();
  getSqlite().run(
    `INSERT INTO cron_jobs (
      id,
      name,
      cron_expression,
      message,
      next_run_at,
      created_by,
      created_at,
      updated_at
    ) VALUES (?, ?, '* * * * *', 'Example scheduled task', ?, 'user', ?, ?)`,
    [id, name, now, now, now],
  );
}

function insertScheduleRun({
  id,
  scheduleId,
  conversationId,
  startedAt,
  finishedAt,
}: {
  id: string;
  scheduleId: string;
  conversationId: string;
  startedAt: number;
  finishedAt: number | null;
}): void {
  getSqlite().run(
    `INSERT INTO cron_runs (
      id,
      job_id,
      status,
      started_at,
      finished_at,
      conversation_id,
      created_at
    ) VALUES (?, ?, 'ok', ?, ?, ?, ?)`,
    [id, scheduleId, startedAt, finishedAt, conversationId, startedAt],
  );
}

function seedScheduleRouteEvents() {
  insertScheduleJob("schedule-a", "Morning summary");
  insertScheduleJob("schedule-b", "Nightly sync");
  insertScheduleRun({
    id: "run-a-1",
    scheduleId: "schedule-a",
    conversationId: "conv-reused",
    startedAt: 1_000,
    finishedAt: 2_000,
  });
  insertScheduleRun({
    id: "run-b-1",
    scheduleId: "schedule-b",
    conversationId: "conv-reused",
    startedAt: 3_000,
    finishedAt: 3_500,
  });

  recordCostAt("conv-reused", "route-before-a", 900, 0.09);
  recordCostAt("conv-reused", "route-a-start", 1_000, 0.1);
  recordCostAt("conv-reused", "route-a-inside", 1_500, 0.2);
  recordCostAt("conv-reused", "route-a-finish", 2_000, 0.3);
  recordCostAt("conv-reused", "route-after-a", 2_500, 0.4);
  recordCostAt("conv-reused", "route-b-inside", 3_200, 0.5);
  recordCostAt("conv-other", "route-other", 1_500, 0.8);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usage routes", () => {
  beforeEach(clearUsageEvents);

  describe("getUsageCostForConversationWindow", () => {
    test("sums only events for the conversation inside the inclusive window", () => {
      recordCostAt("conv-window", "req-before", 999, 0.5);
      recordCostAt("conv-window", "req-start", 1000, 0.01);
      recordCostAt("conv-window", "req-middle", 1500, 0.02);
      recordCostAt("conv-window", "req-end", 2000, 0.03);
      recordCostAt("conv-window", "req-after", 2001, 0.75);
      recordCostAt("conv-other", "req-other", 1500, 0.9);

      const total = getUsageCostForConversationWindow({
        conversationId: "conv-window",
        from: 1000,
        to: 2000,
      });

      expect(total).toBeCloseTo(0.06);
    });
  });

  // -- query parsing / validation --

  describe("query parameter validation", () => {
    test("throws BadRequestError when from/to are missing", () => {
      expect(() => dispatch("GET", "usage/totals")).toThrow(BadRequestError);
    });

    test("throws BadRequestError when from is missing", () => {
      expect(() => dispatch("GET", "usage/totals?to=1000")).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError when to is missing", () => {
      expect(() => dispatch("GET", "usage/totals?from=1000")).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError when from/to are not numbers", () => {
      expect(() => dispatch("GET", "usage/totals?from=abc&to=def")).toThrow(
        BadRequestError,
      );
    });

    test("throws BadRequestError when from > to", () => {
      expect(() => dispatch("GET", "usage/totals?from=2000&to=1000")).toThrow(
        BadRequestError,
      );
    });
  });

  // -- totals --

  describe("GET /v1/usage/totals", () => {
    test("returns zeros for empty range", () => {
      const body = dispatch(
        "GET",
        "usage/totals?from=0&to=999999999999",
      ) as Record<string, number>;
      expect(body.totalInputTokens).toBe(0);
      expect(body.totalOutputTokens).toBe(0);
      expect(body.totalEstimatedCostUsd).toBe(0);
      expect(body.eventCount).toBe(0);
    });

    test("returns correct totals for seeded data", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/totals?from=${from}&to=${to}`,
      ) as Record<string, number>;
      expect(body.totalInputTokens).toBe(3350);
      expect(body.totalOutputTokens).toBe(700);
      expect(body.totalCacheCreationTokens).toBe(50);
      expect(body.totalCacheReadTokens).toBe(100);
      expect(body.eventCount).toBe(3);
      expect(body.pricedEventCount).toBe(2);
      expect(body.unpricedEventCount).toBe(1);
    });

    test("filters by time range", () => {
      const { day1 } = seedEvents();
      // Only day 1 events
      const from = day1 - 1000;
      const to = day1 + 86400_000 - 1;

      const body = dispatch(
        "GET",
        `usage/totals?from=${from}&to=${to}`,
      ) as Record<string, number>;
      expect(body.eventCount).toBe(2);
      expect(body.totalInputTokens).toBe(1350);
      expect(body.totalCacheCreationTokens).toBe(50);
      expect(body.totalCacheReadTokens).toBe(100);
    });

    test("filters by trimmed scheduleId using schedule run windows", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/totals?from=0&to=4000&scheduleId=%20schedule-a%20",
      ) as Record<string, number>;

      expect(body.eventCount).toBe(3);
      expect(body.totalInputTokens).toBe(300);
      expect(body.totalEstimatedCostUsd).toBeCloseTo(0.6);
    });
  });

  // -- daily buckets --

  describe("GET /v1/usage/daily", () => {
    test("returns zero-filled buckets when no events in range", () => {
      const from = new Date("2025-01-15T00:00:00Z").getTime();
      const to = new Date("2025-01-17T23:59:59Z").getTime();
      const body = dispatch("GET", `usage/daily?from=${from}&to=${to}`) as {
        buckets: Array<{
          date: string;
          eventCount: number;
          totalInputTokens: number;
          totalOutputTokens: number;
          totalEstimatedCostUsd: number;
        }>;
      };
      expect(body.buckets).toHaveLength(3);
      expect(body.buckets.map((b) => b.date)).toEqual([
        "2025-01-15",
        "2025-01-16",
        "2025-01-17",
      ]);
      for (const bucket of body.buckets) {
        expect(bucket.eventCount).toBe(0);
        expect(bucket.totalInputTokens).toBe(0);
        expect(bucket.totalOutputTokens).toBe(0);
        expect(bucket.totalEstimatedCostUsd).toBe(0);
      }
    });

    test("returns daily buckets for seeded data", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch("GET", `usage/daily?from=${from}&to=${to}`) as {
        buckets: Array<{
          date: string;
          totalInputTokens: number;
          eventCount: number;
        }>;
      };
      expect(body.buckets).toHaveLength(2);
      expect(body.buckets[0].date).toBe("2025-01-15");
      expect(body.buckets[0].totalInputTokens).toBe(1350);
      expect(body.buckets[0].eventCount).toBe(2);
      expect(body.buckets[1].date).toBe("2025-01-16");
      expect(body.buckets[1].totalInputTokens).toBe(2000);
      expect(body.buckets[1].eventCount).toBe(1);
    });

    test("filters daily buckets by scheduleId", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/daily?from=0&to=4000&scheduleId=schedule-a",
      ) as {
        buckets: Array<{ totalEstimatedCostUsd: number; eventCount: number }>;
      };

      expect(body.buckets).toHaveLength(1);
      expect(body.buckets[0].eventCount).toBe(3);
      expect(body.buckets[0].totalEstimatedCostUsd).toBeCloseTo(0.6);
    });
  });

  // -- breakdown --

  describe("GET /v1/usage/breakdown", () => {
    test("throws BadRequestError when groupBy is missing", () => {
      expect(() =>
        dispatch("GET", "usage/breakdown?from=0&to=999999999999"),
      ).toThrow(BadRequestError);
    });

    test("throws BadRequestError for invalid groupBy value", () => {
      expect(() =>
        dispatch(
          "GET",
          "usage/breakdown?from=0&to=999999999999&groupBy=invalid",
        ),
      ).toThrow(BadRequestError);
    });

    test("groups by provider", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=provider`,
      ) as {
        breakdown: Array<{
          group: string;
          totalInputTokens: number;
          totalCacheCreationTokens: number;
          totalCacheReadTokens: number;
          totalEstimatedCostUsd: number;
          eventCount: number;
        }>;
      };
      expect(body.breakdown).toHaveLength(2);
      expect(body.breakdown[0].group).toBe("anthropic");
      expect(body.breakdown[0].totalInputTokens).toBe(1350);
      expect(body.breakdown[0].totalCacheCreationTokens).toBe(50);
      expect(body.breakdown[0].totalCacheReadTokens).toBe(100);
      expect(body.breakdown[0].totalEstimatedCostUsd).toBeCloseTo(0.006);
      expect(body.breakdown[0].eventCount).toBe(2);

      expect(body.breakdown[1].group).toBe("openai");
      expect(body.breakdown[1].totalInputTokens).toBe(2000);
      expect(body.breakdown[1].totalCacheCreationTokens).toBe(0);
      expect(body.breakdown[1].totalCacheReadTokens).toBe(0);
      expect(body.breakdown[1].totalEstimatedCostUsd).toBe(0);
      expect(body.breakdown[1].eventCount).toBe(1);
    });

    test("groups by actor", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=actor`,
      ) as {
        breakdown: Array<{ group: string; eventCount: number }>;
      };
      expect(body.breakdown).toHaveLength(2);
      const assistantGroup = body.breakdown.find(
        (b) => b.group === "main_agent",
      );
      expect(assistantGroup?.eventCount).toBe(2);
    });

    test("groups by model", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=model`,
      ) as {
        breakdown: Array<{ group: string; eventCount: number }>;
      };
      expect(body.breakdown).toHaveLength(3);
    });

    test("groups by call site with friendly labels and raw keys", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=call_site`,
      ) as {
        breakdown: Array<{
          group: string;
          groupKey: string | null;
          totalInputTokens: number;
          eventCount: number;
        }>;
      };

      expect(body.breakdown.map((row) => row.group)).toEqual([
        "Main Agent",
        "Compaction Agent",
        "Unknown Task",
      ]);
      expect(body.breakdown.map((row) => row.groupKey)).toEqual([
        "mainAgent",
        "compactionAgent",
        null,
      ]);
      expect(
        body.breakdown.find((row) => row.groupKey === null)?.totalInputTokens,
      ).toBe(2000);
    });

    test("groups by inference profile with unset rows", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=inference_profile`,
      ) as {
        breakdown: Array<{ group: string; groupKey: string | null }>;
      };

      expect(body.breakdown.map((row) => row.group)).toEqual([
        "balanced",
        "fast",
        "Default / Unset",
      ]);
      expect(body.breakdown.map((row) => row.groupKey)).toEqual([
        "balanced",
        "fast",
        null,
      ]);
    });

    test("accepts groupBy=schedule and labels groups with schedule names", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/breakdown?from=0&to=4000&groupBy=schedule",
      ) as {
        breakdown: Array<{
          group: string;
          groupId: string | null;
          groupKey: string | null;
          totalEstimatedCostUsd: number;
          eventCount: number;
        }>;
      };

      expect(
        body.breakdown.find((row) => row.groupKey === "schedule-a"),
      ).toMatchObject({
        group: "Morning summary",
        groupId: "schedule-a",
        totalEstimatedCostUsd: 0.6,
        eventCount: 3,
      });
      expect(
        body.breakdown.find((row) => row.groupKey === "schedule-b"),
      ).toMatchObject({
        group: "Nightly sync",
        groupId: "schedule-b",
        totalEstimatedCostUsd: 0.5,
        eventCount: 1,
      });
      expect(body.breakdown.find((row) => row.groupKey === null)).toMatchObject(
        {
          group: "Other",
          groupId: null,
          totalEstimatedCostUsd: 1.29,
          eventCount: 3,
        },
      );
    });

    test("filters breakdown by scheduleId", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/breakdown?from=0&to=4000&groupBy=provider&scheduleId=schedule-a",
      ) as {
        breakdown: Array<{
          group: string;
          totalEstimatedCostUsd: number;
          eventCount: number;
        }>;
      };

      expect(body.breakdown).toHaveLength(1);
      expect(body.breakdown[0]).toMatchObject({
        group: "anthropic",
        totalEstimatedCostUsd: 0.6,
        eventCount: 3,
      });
    });
  });

  describe("GET /v1/usage/series", () => {
    test("throws BadRequestError when groupBy is missing", () => {
      expect(() =>
        dispatch("GET", "usage/series?from=0&to=999999999999"),
      ).toThrow(BadRequestError);
    });

    test("throws BadRequestError for invalid groupBy value", () => {
      expect(() =>
        dispatch(
          "GET",
          "usage/series?from=0&to=999999999999&groupBy=conversation",
        ),
      ).toThrow(BadRequestError);
    });

    test("returns grouped call-site series buckets", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/series?from=${from}&to=${to}&groupBy=call_site&granularity=daily`,
      ) as {
        buckets: Array<{
          date: string;
          totalInputTokens: number;
          groups: Record<
            string,
            { group: string; groupKey: string | null; totalInputTokens: number }
          >;
        }>;
      };

      expect(body.buckets).toHaveLength(2);
      expect(body.buckets[0].groups["value:mainAgent"]).toMatchObject({
        group: "Main Agent",
        groupKey: "mainAgent",
        totalInputTokens: 850,
      });
      expect(body.buckets[0].groups["value:compactionAgent"]).toMatchObject({
        group: "Compaction Agent",
        groupKey: "compactionAgent",
        totalInputTokens: 500,
      });
      expect(body.buckets[1].groups["null:call_site"]).toMatchObject({
        group: "Unknown Task",
        groupKey: null,
        totalInputTokens: 2000,
      });
    });

    test("returns grouped inference-profile series buckets", () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const body = dispatch(
        "GET",
        `usage/series?from=${from}&to=${to}&groupBy=inference_profile&granularity=daily`,
      ) as {
        buckets: Array<{
          groups: Record<
            string,
            { group: string; groupKey: string | null; totalInputTokens: number }
          >;
        }>;
      };

      expect(body.buckets[0].groups["value:balanced"]).toMatchObject({
        group: "balanced",
        groupKey: "balanced",
        totalInputTokens: 850,
      });
      expect(body.buckets[0].groups["value:fast"]).toMatchObject({
        group: "fast",
        groupKey: "fast",
        totalInputTokens: 500,
      });
      expect(body.buckets[1].groups["null:inference_profile"]).toMatchObject({
        group: "Default / Unset",
        groupKey: null,
        totalInputTokens: 2000,
      });
    });

    test("accepts groupBy=schedule and labels schedule series groups", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/series?from=0&to=4000&groupBy=schedule&granularity=daily",
      ) as {
        buckets: Array<{
          groups: Record<
            string,
            {
              group: string;
              groupKey: string | null;
              totalEstimatedCostUsd: number;
            }
          >;
        }>;
      };

      expect(body.buckets).toHaveLength(1);
      expect(body.buckets[0].groups["value:schedule-a"]).toMatchObject({
        group: "Morning summary",
        groupKey: "schedule-a",
      });
      expect(
        body.buckets[0].groups["value:schedule-a"].totalEstimatedCostUsd,
      ).toBeCloseTo(0.6);
      expect(body.buckets[0].groups["value:schedule-b"]).toMatchObject({
        group: "Nightly sync",
        groupKey: "schedule-b",
      });
      expect(
        body.buckets[0].groups["value:schedule-b"].totalEstimatedCostUsd,
      ).toBeCloseTo(0.5);
      expect(body.buckets[0].groups["null:schedule"]).toMatchObject({
        group: "Other",
        groupKey: null,
      });
      expect(
        body.buckets[0].groups["null:schedule"].totalEstimatedCostUsd,
      ).toBeCloseTo(1.29);
    });

    test("filters grouped series by scheduleId", () => {
      seedScheduleRouteEvents();

      const body = dispatch(
        "GET",
        "usage/series?from=0&to=4000&groupBy=call_site&granularity=daily&scheduleId=schedule-a",
      ) as {
        buckets: Array<{
          totalEstimatedCostUsd: number;
          groups: Record<string, { totalEstimatedCostUsd: number }>;
        }>;
      };

      expect(body.buckets).toHaveLength(1);
      expect(body.buckets[0].totalEstimatedCostUsd).toBeCloseTo(0.6);
      expect(body.buckets[0].groups["value:mainAgent"]).toMatchObject({
        group: "Main Agent",
        groupKey: "mainAgent",
      });
      expect(
        body.buckets[0].groups["value:mainAgent"].totalEstimatedCostUsd,
      ).toBeCloseTo(0.6);
    });
  });
});
