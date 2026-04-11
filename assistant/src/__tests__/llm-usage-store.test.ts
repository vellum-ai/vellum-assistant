import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, initializeDb } from "../memory/db.js";
import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageHourBuckets,
  getUsageTotals,
  listUsageEvents,
  queryUnreportedUsageEvents,
  recordUsageEvent,
} from "../memory/llm-usage-store.js";
import type { PricingResult, UsageEventInput } from "../usage/types.js";

// Initialize db once before all tests
initializeDb();

function makeInput(overrides?: Partial<UsageEventInput>): UsageEventInput {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    actor: "main_agent",
    conversationId: null,
    runId: null,
    requestId: null,
    ...overrides,
  };
}

const pricedResult: PricingResult = {
  estimatedCostUsd: 0.0045,
  pricingStatus: "priced",
};

const unpricedResult: PricingResult = {
  estimatedCostUsd: null,
  pricingStatus: "unpriced",
};

/** Insert an event at a specific epoch-millis timestamp. */
function insertEventAt(
  timestamp: number,
  inputOverrides?: Partial<UsageEventInput>,
  pricing: PricingResult = pricedResult,
): void {
  const event = recordUsageEvent(makeInput(inputOverrides), pricing);
  const db = getDb();
  db.run(
    `UPDATE llm_usage_events SET created_at = ${timestamp} WHERE id = '${event.id}'`,
  );
}

describe("recordUsageEvent", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("persists an event and returns it with id and createdAt", () => {
    const input = makeInput();
    const event = recordUsageEvent(input, pricedResult);

    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.createdAt).toBeDefined();
    expect(typeof event.createdAt).toBe("number");
    expect(event.provider).toBe("anthropic");
    expect(event.model).toBe("claude-sonnet-4-20250514");
    expect(event.inputTokens).toBe(1000);
    expect(event.outputTokens).toBe(500);
    expect(event.actor).toBe("main_agent");
    expect(event.estimatedCostUsd).toBe(0.0045);
    expect(event.pricingStatus).toBe("priced");
  });

  test("persists a priced event that can be retrieved", () => {
    const input = makeInput({ conversationId: "c1" });
    const event = recordUsageEvent(input, pricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    expect(events[0].estimatedCostUsd).toBe(0.0045);
    expect(events[0].pricingStatus).toBe("priced");
    expect(events[0].conversationId).toBe("c1");
  });

  test("persists an unpriced event", () => {
    const input = makeInput({ provider: "ollama", model: "llama3" });
    const event = recordUsageEvent(input, unpricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    expect(events[0].estimatedCostUsd).toBeNull();
    expect(events[0].pricingStatus).toBe("unpriced");
    expect(events[0].provider).toBe("ollama");
    expect(events[0].model).toBe("llama3");
  });

  test("handles null optional fields", () => {
    const input = makeInput({
      conversationId: null,
      runId: null,
      requestId: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    const _event = recordUsageEvent(input, unpricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBeNull();
    expect(events[0].runId).toBeNull();
    expect(events[0].requestId).toBeNull();
    expect(events[0].cacheCreationInputTokens).toBeNull();
    expect(events[0].cacheReadInputTokens).toBeNull();
  });

  test("handles populated optional fields", () => {
    const input = makeInput({
      conversationId: "conv-1",
      runId: "run-1",
      requestId: "req-1",
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    });
    const _event = recordUsageEvent(input, pricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBe("conv-1");
    expect(events[0].runId).toBe("run-1");
    expect(events[0].requestId).toBe("req-1");
    expect(events[0].cacheCreationInputTokens).toBe(200);
    expect(events[0].cacheReadInputTokens).toBe(300);
  });
});

describe("listUsageEvents", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("returns events in descending createdAt order", () => {
    // Insert events with small delays to ensure different timestamps
    const event1 = recordUsageEvent(
      makeInput({ model: "model-a" }),
      pricedResult,
    );
    // Manually adjust createdAt for deterministic ordering
    const db = getDb();
    db.run(
      `UPDATE llm_usage_events SET created_at = 1000 WHERE id = '${event1.id}'`,
    );

    const event2 = recordUsageEvent(
      makeInput({ model: "model-b" }),
      pricedResult,
    );
    db.run(
      `UPDATE llm_usage_events SET created_at = 2000 WHERE id = '${event2.id}'`,
    );

    const event3 = recordUsageEvent(
      makeInput({ model: "model-c" }),
      pricedResult,
    );
    db.run(
      `UPDATE llm_usage_events SET created_at = 3000 WHERE id = '${event3.id}'`,
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(3);
    expect(events[0].model).toBe("model-c");
    expect(events[1].model).toBe("model-b");
    expect(events[2].model).toBe("model-a");
  });

  test("respects the limit option", () => {
    recordUsageEvent(makeInput({ model: "model-a" }), pricedResult);
    recordUsageEvent(makeInput({ model: "model-b" }), pricedResult);
    recordUsageEvent(makeInput({ model: "model-c" }), pricedResult);

    const events = listUsageEvents({ limit: 2 });
    expect(events).toHaveLength(2);
  });

  test("defaults to limit of 100", () => {
    // Just verify it returns without error when no limit is specified
    const events = listUsageEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  test("returns empty array when no events exist", () => {
    const events = listUsageEvents();
    expect(events).toHaveLength(0);
  });

  test("returns events with correct types", () => {
    recordUsageEvent(
      makeInput({
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
      }),
      pricedResult,
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    const event = events[0];

    // Verify all fields have correct types
    expect(typeof event.id).toBe("string");
    expect(typeof event.createdAt).toBe("number");
    expect(typeof event.actor).toBe("string");
    expect(typeof event.provider).toBe("string");
    expect(typeof event.model).toBe("string");
    expect(typeof event.inputTokens).toBe("number");
    expect(typeof event.outputTokens).toBe("number");
    expect(typeof event.cacheCreationInputTokens).toBe("number");
    expect(typeof event.cacheReadInputTokens).toBe("number");
    expect(typeof event.estimatedCostUsd).toBe("number");
    expect(typeof event.pricingStatus).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Aggregation query tests
// ---------------------------------------------------------------------------

describe("getUsageTotals", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("returns zeros when no events exist in range", () => {
    const totals = getUsageTotals({ from: 0, to: 99999 });
    expect(totals.totalInputTokens).toBe(0);
    expect(totals.totalOutputTokens).toBe(0);
    expect(totals.totalCacheCreationTokens).toBe(0);
    expect(totals.totalCacheReadTokens).toBe(0);
    expect(totals.totalEstimatedCostUsd).toBe(0);
    expect(totals.eventCount).toBe(0);
    expect(totals.pricedEventCount).toBe(0);
    expect(totals.unpricedEventCount).toBe(0);
  });

  test("sums direct input, cache tokens, and cost across priced events", () => {
    insertEventAt(
      1000,
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 25,
        cacheReadInputTokens: 50,
      },
      {
        estimatedCostUsd: 0.01,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      2000,
      {
        inputTokens: 200,
        outputTokens: 100,
        cacheCreationInputTokens: 75,
        cacheReadInputTokens: 125,
      },
      {
        estimatedCostUsd: 0.02,
        pricingStatus: "priced",
      },
    );

    const totals = getUsageTotals({ from: 0, to: 5000 });
    expect(totals.totalInputTokens).toBe(300);
    expect(totals.totalOutputTokens).toBe(150);
    expect(totals.totalCacheCreationTokens).toBe(100);
    expect(totals.totalCacheReadTokens).toBe(175);
    expect(totals.totalEstimatedCostUsd).toBeCloseTo(0.03);
    expect(totals.eventCount).toBe(2);
    expect(totals.pricedEventCount).toBe(2);
    expect(totals.unpricedEventCount).toBe(0);
  });

  test("counts priced and unpriced events separately", () => {
    insertEventAt(1000, {}, pricedResult);
    insertEventAt(
      2000,
      { provider: "ollama", model: "llama3" },
      unpricedResult,
    );

    const totals = getUsageTotals({ from: 0, to: 5000 });
    expect(totals.eventCount).toBe(2);
    expect(totals.pricedEventCount).toBe(1);
    expect(totals.unpricedEventCount).toBe(1);
  });

  test("respects time range boundaries (inclusive)", () => {
    insertEventAt(1000);
    insertEventAt(2000);
    insertEventAt(3000);

    // Only the middle event
    const totals = getUsageTotals({ from: 2000, to: 2000 });
    expect(totals.eventCount).toBe(1);
  });

  test("excludes events outside the time range", () => {
    insertEventAt(500);
    insertEventAt(5000);

    const totals = getUsageTotals({ from: 1000, to: 4000 });
    expect(totals.eventCount).toBe(0);
  });

  test("sums cache tokens including nulls", () => {
    insertEventAt(1000, {
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 100,
    });
    insertEventAt(2000, {
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });

    const totals = getUsageTotals({ from: 0, to: 5000 });
    expect(totals.totalCacheCreationTokens).toBe(50);
    expect(totals.totalCacheReadTokens).toBe(100);
  });
});

describe("getUsageDayBuckets", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  // Helper: epoch millis for a UTC date
  function utcMs(year: number, month: number, day: number, hour = 0): number {
    return Date.UTC(year, month - 1, day, hour);
  }

  test("returns empty array when no events exist", () => {
    const buckets = getUsageDayBuckets({ from: 0, to: 99999999999 });
    expect(buckets).toHaveLength(0);
  });

  test("groups direct input into correct day buckets without double-counting cache tokens", () => {
    const day1Start = utcMs(2025, 3, 1, 0);
    const day1Mid = utcMs(2025, 3, 1, 12);
    const day2Start = utcMs(2025, 3, 2, 6);

    insertEventAt(day1Start, { inputTokens: 100, outputTokens: 10 });
    insertEventAt(day1Mid, {
      inputTokens: 200,
      outputTokens: 20,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 100,
    });
    insertEventAt(day2Start, {
      inputTokens: 300,
      outputTokens: 30,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
    });

    const buckets = getUsageDayBuckets({
      from: utcMs(2025, 3, 1),
      to: utcMs(2025, 3, 3),
    });

    expect(buckets).toHaveLength(2);
    expect(buckets[0].date).toBe("2025-03-01");
    expect(buckets[0].totalInputTokens).toBe(300);
    expect(buckets[0].totalOutputTokens).toBe(30);
    expect(buckets[0].eventCount).toBe(2);

    expect(buckets[1].date).toBe("2025-03-02");
    expect(buckets[1].totalInputTokens).toBe(300);
    expect(buckets[1].totalOutputTokens).toBe(30);
    expect(buckets[1].eventCount).toBe(1);
  });

  test("buckets are ordered by date ascending", () => {
    insertEventAt(utcMs(2025, 3, 3));
    insertEventAt(utcMs(2025, 3, 1));
    insertEventAt(utcMs(2025, 3, 2));

    const buckets = getUsageDayBuckets({
      from: utcMs(2025, 3, 1),
      to: utcMs(2025, 3, 4),
    });
    expect(buckets.map((b) => b.date)).toEqual([
      "2025-03-01",
      "2025-03-02",
      "2025-03-03",
    ]);
  });

  test("handles day boundary correctly (midnight UTC)", () => {
    // Last millisecond of March 1 and first millisecond of March 2
    const endOfDay1 = utcMs(2025, 3, 1, 23) + 59 * 60 * 1000 + 59 * 1000;
    const startOfDay2 = utcMs(2025, 3, 2, 0);

    insertEventAt(endOfDay1, { inputTokens: 111 });
    insertEventAt(startOfDay2, { inputTokens: 222 });

    const buckets = getUsageDayBuckets({
      from: utcMs(2025, 3, 1),
      to: utcMs(2025, 3, 3),
    });

    expect(buckets).toHaveLength(2);
    expect(buckets[0].date).toBe("2025-03-01");
    expect(buckets[0].totalInputTokens).toBe(111);
    expect(buckets[1].date).toBe("2025-03-02");
    expect(buckets[1].totalInputTokens).toBe(222);
  });

  test("sums cost correctly with mixed priced/unpriced events", () => {
    const day = utcMs(2025, 3, 1);
    insertEventAt(day, {}, { estimatedCostUsd: 0.05, pricingStatus: "priced" });
    insertEventAt(day + 1000, { provider: "ollama" }, unpricedResult);

    const buckets = getUsageDayBuckets({
      from: utcMs(2025, 3, 1),
      to: utcMs(2025, 3, 2),
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalEstimatedCostUsd).toBeCloseTo(0.05);
    expect(buckets[0].eventCount).toBe(2);
  });
});

describe("getUsageDayBuckets — timezone-aware", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("integer offset: anchors daily buckets to local midnight", () => {
    // 2026-04-10T22:30:00Z is 15:30 PDT (UTC-7) on 2026-04-10.
    // 2026-04-11T06:30:00Z is 23:30 PDT on 2026-04-10 (same local day).
    insertEventAt(Date.UTC(2026, 3, 10, 22, 30), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 3, 11, 6, 30), { inputTokens: 200 });
    // 2026-04-11T08:00:00Z is 01:00 PDT on 2026-04-11 (next local day).
    insertEventAt(Date.UTC(2026, 3, 11, 8, 0), { inputTokens: 400 });

    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 3, 10, 0), to: Date.UTC(2026, 3, 12, 0) },
      "America/Los_Angeles",
    );

    expect(buckets.map((b) => b.date)).toEqual(["2026-04-10", "2026-04-11"]);
    expect(buckets[0].totalInputTokens).toBe(300);
    expect(buckets[1].totalInputTokens).toBe(400);
    expect(buckets[0].displayLabel).toBeDefined();
    expect(buckets[1].displayLabel).toBeDefined();
  });

  test("fractional offset: anchors daily buckets to local midnight in IST", () => {
    // Asia/Kolkata is UTC+5:30. Local midnight April 10 IST = 18:30 UTC April 9.
    // Event at 18:31 UTC April 9 = 00:01 IST April 10.
    // Event at 18:29 UTC April 9 = 23:59 IST April 9.
    insertEventAt(Date.UTC(2026, 3, 9, 18, 31), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 3, 9, 18, 29), { inputTokens: 50 });

    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 3, 9, 0), to: Date.UTC(2026, 3, 10, 23) },
      "Asia/Kolkata",
    );

    // The 18:31 UTC event should land on 2026-04-10 IST, the 18:29 UTC event
    // on 2026-04-09 IST.
    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-04-09"]?.totalInputTokens).toBe(50);
    expect(map["2026-04-10"]?.totalInputTokens).toBe(100);
  });

  test("backwards compat: default tz is UTC", () => {
    insertEventAt(Date.UTC(2025, 5, 1, 0, 0), { inputTokens: 111 });
    insertEventAt(Date.UTC(2025, 5, 1, 23, 59), { inputTokens: 222 });
    insertEventAt(Date.UTC(2025, 5, 2, 0, 0), { inputTokens: 333 });

    const buckets = getUsageDayBuckets({
      from: Date.UTC(2025, 5, 1, 0),
      to: Date.UTC(2025, 5, 2, 12),
    });

    expect(buckets.map((b) => b.date)).toEqual(["2025-06-01", "2025-06-02"]);
    expect(buckets[0].totalInputTokens).toBe(333); // 111 + 222
    expect(buckets[1].totalInputTokens).toBe(333);
  });

  test("throws on invalid timezone identifier", () => {
    expect(() =>
      getUsageDayBuckets({ from: 0, to: 1000 }, "Not/A/Real/Zone"),
    ).toThrow(/Invalid IANA timezone identifier/);
  });

  test("fillEmpty seeds zero buckets for empty days", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 12), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 3, 12, 12), { inputTokens: 200 });

    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 3, 10, 0), to: Date.UTC(2026, 3, 12, 23) },
      "UTC",
      { fillEmpty: true },
    );

    expect(buckets.map((b) => b.date)).toEqual([
      "2026-04-10",
      "2026-04-11",
      "2026-04-12",
    ]);
    expect(buckets[0].totalInputTokens).toBe(100);
    expect(buckets[1].totalInputTokens).toBe(0);
    expect(buckets[1].eventCount).toBe(0);
    expect(buckets[2].totalInputTokens).toBe(200);
  });
});

describe("getUsageHourBuckets — timezone-aware", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("integer offset: buckets align to local-hour boundaries in PDT", () => {
    // 2026-04-10T22:00:00Z = 15:00 PDT = "2026-04-10 15:00" bucket
    // 2026-04-10T22:30:00Z = 15:30 PDT = same bucket
    // 2026-04-10T23:00:00Z = 16:00 PDT = next bucket
    insertEventAt(Date.UTC(2026, 3, 10, 22, 0), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 3, 10, 22, 30), { inputTokens: 200 });
    insertEventAt(Date.UTC(2026, 3, 10, 23, 0), { inputTokens: 300 });

    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 3, 10, 21), to: Date.UTC(2026, 3, 11, 0) },
      "America/Los_Angeles",
    );

    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-04-10 15:00"]?.totalInputTokens).toBe(300);
    expect(map["2026-04-10 16:00"]?.totalInputTokens).toBe(300);
    expect(map["2026-04-10 15:00"]?.displayLabel).toBe("3pm");
    expect(map["2026-04-10 16:00"]?.displayLabel).toBe("4pm");
  });

  test("fractional offset: events in a half-hour-offset tz bucket to correct local hour", () => {
    // Asia/Kolkata UTC+5:30.
    // 13:30 UTC = 19:00 IST → "19:00" bucket
    // 13:45 UTC = 19:15 IST → "19:00" bucket (same)
    // 14:15 UTC = 19:45 IST → "19:00" bucket (same)
    // 14:31 UTC = 20:01 IST → "20:00" bucket
    insertEventAt(Date.UTC(2026, 3, 10, 13, 30), { inputTokens: 10 });
    insertEventAt(Date.UTC(2026, 3, 10, 13, 45), { inputTokens: 20 });
    insertEventAt(Date.UTC(2026, 3, 10, 14, 15), { inputTokens: 30 });
    insertEventAt(Date.UTC(2026, 3, 10, 14, 31), { inputTokens: 40 });

    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 3, 10, 12), to: Date.UTC(2026, 3, 10, 16) },
      "Asia/Kolkata",
    );

    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-04-10 19:00"]?.totalInputTokens).toBe(60);
    expect(map["2026-04-10 20:00"]?.totalInputTokens).toBe(40);
  });

  test("DST spring forward: skipped hour does not produce a bucket", () => {
    // America/New_York 2026-03-08: 2:00 AM EST jumps to 3:00 AM EDT.
    // Event at 06:30 UTC = 01:30 EST (before jump) → "01:00" bucket
    // Event at 07:30 UTC = 03:30 EDT (after jump) → "03:00" bucket
    insertEventAt(Date.UTC(2026, 2, 8, 6, 30), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 2, 8, 7, 30), { inputTokens: 200 });

    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 2, 8, 5), to: Date.UTC(2026, 2, 8, 9) },
      "America/New_York",
      { fillEmpty: true },
    );

    const bucketLabels = buckets.map((b) => b.date);
    // The 02:00 local hour should not appear on spring-forward day.
    expect(bucketLabels).not.toContain("2026-03-08 02:00");
    // Both 01:00 and 03:00 should be present.
    expect(bucketLabels).toContain("2026-03-08 01:00");
    expect(bucketLabels).toContain("2026-03-08 03:00");

    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-03-08 01:00"]?.totalInputTokens).toBe(100);
    expect(map["2026-03-08 03:00"]?.totalInputTokens).toBe(200);
  });

  test("DST fall back: duplicate 1am local hour is preserved as two buckets", () => {
    // America/New_York 2026-11-01: 2:00 AM EDT falls back to 1:00 AM EST.
    // Event at 05:30 UTC = 01:30 EDT (first 1am) → EDT 01:00 bucket
    // Event at 06:30 UTC = 01:30 EST (second 1am) → EST 01:00 bucket (distinct!)
    insertEventAt(Date.UTC(2026, 10, 1, 5, 30), { inputTokens: 100 });
    insertEventAt(Date.UTC(2026, 10, 1, 6, 30), { inputTokens: 200 });

    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 10, 1, 4), to: Date.UTC(2026, 10, 1, 8) },
      "America/New_York",
    );

    // Both events should share the same `date` string but be in different
    // bucket entries (disambiguated by UTC offset internally).
    const oneAmBuckets = buckets.filter((b) => b.date === "2026-11-01 01:00");
    expect(oneAmBuckets).toHaveLength(2);
    const totalInputs = oneAmBuckets.reduce(
      (sum, b) => sum + b.totalInputTokens,
      0,
    );
    expect(totalInputs).toBe(300);
    // Both should share the "1am" display label.
    expect(oneAmBuckets[0].displayLabel).toBe("1am");
    expect(oneAmBuckets[1].displayLabel).toBe("1am");
  });

  test("fillEmpty seeds zero buckets for empty hours in range", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 14), { inputTokens: 100 });

    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 3, 10, 12), to: Date.UTC(2026, 3, 10, 16) },
      "UTC",
      { fillEmpty: true },
    );

    // Hours 12, 13, 14, 15, 16 = 5 buckets
    expect(buckets.length).toBeGreaterThanOrEqual(4);
    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-04-10 14:00"]?.totalInputTokens).toBe(100);
    expect(map["2026-04-10 13:00"]?.totalInputTokens).toBe(0);
    expect(map["2026-04-10 12:00"]?.eventCount).toBe(0);
  });

  test("generates lowercase hour display labels like '3pm'", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 22, 0), { inputTokens: 100 });
    const buckets = getUsageHourBuckets(
      { from: Date.UTC(2026, 3, 10, 22), to: Date.UTC(2026, 3, 10, 23) },
      "America/Los_Angeles",
    );
    const withEvents = buckets.find((b) => b.totalInputTokens === 100);
    expect(withEvents?.displayLabel).toBe("3pm");
  });
});

describe("getUsageGroupBreakdown", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("returns empty array when no events exist", () => {
    const groups = getUsageGroupBreakdown({ from: 0, to: 99999 }, "actor");
    expect(groups).toHaveLength(0);
  });

  test("groups by actor with direct input and cache totals kept separate", () => {
    insertEventAt(
      1000,
      {
        actor: "main_agent",
        inputTokens: 100,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 50,
      },
      {
        estimatedCostUsd: 0.01,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      2000,
      {
        actor: "main_agent",
        inputTokens: 200,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 25,
      },
      {
        estimatedCostUsd: 0.02,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      3000,
      { actor: "title_generator", inputTokens: 50 },
      {
        estimatedCostUsd: 0.005,
        pricingStatus: "priced",
      },
    );

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "actor");
    expect(groups).toHaveLength(2);

    // Ordered by cost descending
    expect(groups[0].group).toBe("main_agent");
    expect(groups[0].totalInputTokens).toBe(300);
    expect(groups[0].totalCacheCreationTokens).toBe(50);
    expect(groups[0].totalCacheReadTokens).toBe(75);
    expect(groups[0].totalEstimatedCostUsd).toBeCloseTo(0.03);
    expect(groups[0].eventCount).toBe(2);

    expect(groups[1].group).toBe("title_generator");
    expect(groups[1].totalInputTokens).toBe(50);
    expect(groups[1].totalCacheCreationTokens).toBe(0);
    expect(groups[1].totalCacheReadTokens).toBe(0);
    expect(groups[1].eventCount).toBe(1);
  });

  test("groups by provider", () => {
    insertEventAt(
      1000,
      { provider: "anthropic" },
      {
        estimatedCostUsd: 0.05,
        pricingStatus: "priced",
      },
    );
    insertEventAt(2000, { provider: "ollama" }, unpricedResult);

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "provider");
    expect(groups).toHaveLength(2);
    expect(groups[0].group).toBe("anthropic");
    expect(groups[0].totalEstimatedCostUsd).toBeCloseTo(0.05);
    expect(groups[1].group).toBe("ollama");
    expect(groups[1].totalEstimatedCostUsd).toBe(0);
  });

  test("groups by model", () => {
    insertEventAt(
      1000,
      { model: "claude-sonnet-4-20250514" },
      {
        estimatedCostUsd: 0.03,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      2000,
      { model: "claude-sonnet-4-20250514" },
      {
        estimatedCostUsd: 0.02,
        pricingStatus: "priced",
      },
    );
    insertEventAt(3000, { model: "llama3" }, unpricedResult);

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "model");
    expect(groups).toHaveLength(2);
    expect(groups[0].group).toBe("claude-sonnet-4-20250514");
    expect(groups[0].totalEstimatedCostUsd).toBeCloseTo(0.05);
    expect(groups[0].eventCount).toBe(2);
    expect(groups[1].group).toBe("llama3");
  });

  test("respects time range", () => {
    insertEventAt(1000, { actor: "main_agent" });
    insertEventAt(5000, { actor: "title_generator" });

    const groups = getUsageGroupBreakdown({ from: 2000, to: 4000 }, "actor");
    expect(groups).toHaveLength(0);
  });

  test("orders groups by estimated cost descending", () => {
    insertEventAt(
      1000,
      { actor: "main_agent" },
      {
        estimatedCostUsd: 0.01,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      2000,
      { actor: "title_generator" },
      {
        estimatedCostUsd: 0.05,
        pricingStatus: "priced",
      },
    );
    insertEventAt(
      3000,
      { actor: "context_compactor" },
      {
        estimatedCostUsd: 0.03,
        pricingStatus: "priced",
      },
    );

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "actor");
    expect(groups[0].group).toBe("title_generator");
    expect(groups[1].group).toBe("context_compactor");
    expect(groups[2].group).toBe("main_agent");
  });
});

// ---------------------------------------------------------------------------
// queryUnreportedUsageEvents tests
// ---------------------------------------------------------------------------

describe("queryUnreportedUsageEvents", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("returns events with createdAt strictly greater than afterCreatedAt in ascending order", () => {
    insertEventAt(1000, { model: "model-a" });
    insertEventAt(2000, { model: "model-b" });
    insertEventAt(3000, { model: "model-c" });

    // afterCreatedAt = 1000 should exclude the event at exactly 1000
    const events = queryUnreportedUsageEvents(1000, undefined, 100);
    expect(events).toHaveLength(2);
    expect(events[0].model).toBe("model-b");
    expect(events[0].createdAt).toBe(2000);
    expect(events[1].model).toBe("model-c");
    expect(events[1].createdAt).toBe(3000);
  });

  test("respects the limit parameter", () => {
    insertEventAt(1000, { model: "model-a" });
    insertEventAt(2000, { model: "model-b" });
    insertEventAt(3000, { model: "model-c" });

    const events = queryUnreportedUsageEvents(0, undefined, 2);
    expect(events).toHaveLength(2);
    // Should return the earliest two due to ASC ordering
    expect(events[0].model).toBe("model-a");
    expect(events[1].model).toBe("model-b");
  });

  test("returns empty array when no events match", () => {
    insertEventAt(1000, { model: "model-a" });

    const events = queryUnreportedUsageEvents(2000, undefined, 100);
    expect(events).toHaveLength(0);
  });

  test("returns empty array when table is empty", () => {
    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(0);
  });
});
