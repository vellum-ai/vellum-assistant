import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/usage-routes.js";

initializeDb();

function clearUsageEvents() {
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
    },
    { estimatedCostUsd: 0, pricingStatus: "unpriced" },
  );
  getSqlite().run(
    "UPDATE llm_usage_events SET created_at = ? WHERE request_id = 'req-3'",
    [day2],
  );

  return { day1, day2 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usage routes", () => {
  beforeEach(clearUsageEvents);

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
        "Main agent",
        "Context compactor",
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
        group: "Main agent",
        groupKey: "mainAgent",
        totalInputTokens: 850,
      });
      expect(body.buckets[0].groups["value:compactionAgent"]).toMatchObject({
        group: "Context compactor",
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
  });
});
