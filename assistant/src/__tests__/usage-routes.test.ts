import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import { recordUsageEvent } from "../memory/llm-usage-store.js";
import { usageRouteDefinitions } from "../runtime/routes/usage-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
});

function clearUsageEvents() {
  getSqlite().run("DELETE FROM llm_usage_events");
}

// Build a simple dispatch helper from route definitions
const routes = usageRouteDefinitions();

function dispatch(method: string, path: string): Promise<Response> | Response {
  const url = new URL(`http://localhost/v1/${path}`);
  const req = new Request(url.toString(), { method });
  const route = routes.find(
    (r) =>
      r.method === method &&
      `usage/${url.pathname.split("/v1/usage/")[1]?.split("?")[0]}` ===
        r.endpoint,
  );
  if (!route) throw new Error(`No route for ${method} /v1/${path}`);
  return route.handler({
    req,
    url,
    server: null as never,
    authContext: {} as never,
    params: {},
  });
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
    test("returns 400 when from/to are missing", async () => {
      const res = await dispatch("GET", "usage/totals");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("from");
    });

    test("returns 400 when from is missing", async () => {
      const res = await dispatch("GET", "usage/totals?to=1000");
      expect(res.status).toBe(400);
    });

    test("returns 400 when to is missing", async () => {
      const res = await dispatch("GET", "usage/totals?from=1000");
      expect(res.status).toBe(400);
    });

    test("returns 400 when from/to are not numbers", async () => {
      const res = await dispatch("GET", "usage/totals?from=abc&to=def");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("valid numbers");
    });

    test("returns 400 when from > to", async () => {
      const res = await dispatch("GET", "usage/totals?from=2000&to=1000");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("less than or equal");
    });
  });

  // -- totals --

  describe("GET /v1/usage/totals", () => {
    test("returns zeros for empty range", async () => {
      const res = await dispatch("GET", "usage/totals?from=0&to=999999999999");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, number>;
      expect(body.totalInputTokens).toBe(0);
      expect(body.totalOutputTokens).toBe(0);
      expect(body.totalEstimatedCostUsd).toBe(0);
      expect(body.eventCount).toBe(0);
    });

    test("returns correct totals for seeded data", async () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const res = await dispatch("GET", `usage/totals?from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, number>;
      expect(body.totalInputTokens).toBe(3350);
      expect(body.totalOutputTokens).toBe(700);
      expect(body.totalCacheCreationTokens).toBe(50);
      expect(body.totalCacheReadTokens).toBe(100);
      expect(body.eventCount).toBe(3);
      expect(body.pricedEventCount).toBe(2);
      expect(body.unpricedEventCount).toBe(1);
    });

    test("filters by time range", async () => {
      const { day1 } = seedEvents();
      // Only day 1 events
      const from = day1 - 1000;
      const to = day1 + 86400_000 - 1;

      const res = await dispatch("GET", `usage/totals?from=${from}&to=${to}`);
      const body = (await res.json()) as Record<string, number>;
      expect(body.eventCount).toBe(2);
      expect(body.totalInputTokens).toBe(1350);
      expect(body.totalCacheCreationTokens).toBe(50);
      expect(body.totalCacheReadTokens).toBe(100);
    });
  });

  // -- daily buckets --

  describe("GET /v1/usage/daily", () => {
    test("returns empty buckets array for empty range", async () => {
      const res = await dispatch("GET", "usage/daily?from=0&to=999999999999");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { buckets: unknown[] };
      expect(body.buckets).toEqual([]);
    });

    test("returns daily buckets for seeded data", async () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const res = await dispatch("GET", `usage/daily?from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
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
    test("returns 400 when groupBy is missing", async () => {
      const res = await dispatch(
        "GET",
        "usage/breakdown?from=0&to=999999999999",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("groupBy");
    });

    test("returns 400 for invalid groupBy value", async () => {
      const res = await dispatch(
        "GET",
        "usage/breakdown?from=0&to=999999999999&groupBy=invalid",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("invalid");
    });

    test("groups by provider", async () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const res = await dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=provider`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
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

    test("groups by actor", async () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const res = await dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=actor`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        breakdown: Array<{ group: string; eventCount: number }>;
      };
      expect(body.breakdown).toHaveLength(2);
      const assistantGroup = body.breakdown.find(
        (b) => b.group === "main_agent",
      );
      expect(assistantGroup?.eventCount).toBe(2);
    });

    test("groups by model", async () => {
      const { day1, day2 } = seedEvents();
      const from = day1 - 1000;
      const to = day2 + 1000;

      const res = await dispatch(
        "GET",
        `usage/breakdown?from=${from}&to=${to}&groupBy=model`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        breakdown: Array<{ group: string; eventCount: number }>;
      };
      expect(body.breakdown).toHaveLength(3);
    });
  });
});
