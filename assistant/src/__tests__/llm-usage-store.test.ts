import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageGroupedSeries,
  getUsageHourBuckets,
  getUsageTotals,
  listRunConversationIds,
  listUsageEvents,
  queryUnreportedUsageEvents,
  recordUsageEvent,
} from "../persistence/llm-usage-store.js";
import type { PricingResult, UsageEventInput } from "../usage/types.js";

// Initialize db once before all tests
await initializeDb();

function makeInput(overrides?: Partial<UsageEventInput>): UsageEventInput {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    rawUsage: null,
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

  test("persists call-site and inference-profile attribution", () => {
    const event = recordUsageEvent(
      makeInput({
        callSite: "mainAgent",
        inferenceProfile: "balanced",
        inferenceProfileSource: "conversation",
      }),
      pricedResult,
    );

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(event.callSite).toBe("mainAgent");
    expect(event.inferenceProfile).toBe("balanced");
    expect(event.inferenceProfileSource).toBe("conversation");
    expect(events[0].callSite).toBe("mainAgent");
    expect(events[0].inferenceProfile).toBe("balanced");
    expect(events[0].inferenceProfileSource).toBe("conversation");
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
    expect(events[0].callSite).toBeNull();
    expect(events[0].inferenceProfile).toBeNull();
    expect(events[0].inferenceProfileSource).toBeNull();
    expect(events[0].cacheCreationInputTokens).toBeNull();
    expect(events[0].cacheReadInputTokens).toBeNull();
  });

  test("reads old-shape rows with null attribution", () => {
    const db = getDb();
    db.run(/*sql*/ `
      INSERT INTO llm_usage_events (
        id,
        created_at,
        conversation_id,
        run_id,
        request_id,
        actor,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        estimated_cost_usd,
        pricing_status,
        llm_call_count,
        metadata_json
      ) VALUES (
        'old-row',
        1000,
        NULL,
        NULL,
        NULL,
        'main_agent',
        'anthropic',
        'claude-sonnet-4-20250514',
        100,
        50,
        NULL,
        NULL,
        0.001,
        'priced',
        1,
        NULL
      )
    `);

    const [event] = listUsageEvents();
    expect(event.callSite).toBeNull();
    expect(event.inferenceProfile).toBeNull();
    expect(event.inferenceProfileSource).toBeNull();
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

  test("round-trips the provider's raw_usage payload verbatim", () => {
    // The `raw_usage` column carries the literal usage object the provider
    // returned (Anthropic nests TTL breakdown under `cache_creation`,
    // OpenAI nests cached-read details under `prompt_tokens_details`, etc.)
    // It must round-trip from `recordUsageEvent` through SQLite back to
    // `listUsageEvents` byte-for-byte so downstream consumers can extract
    // any provider-specific detail without a schema change.
    const rawUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 500,
      cache_creation: {
        ephemeral_5m_input_tokens: 100,
        ephemeral_1h_input_tokens: 400,
      },
      cache_read_input_tokens: 0,
      service_tier: "standard",
    };
    recordUsageEvent(makeInput({ rawUsage }), pricedResult);

    const [event] = listUsageEvents();
    expect(event.rawUsage).toEqual(rawUsage);
  });

  test("raw_usage defaults to null when the provider did not return one", () => {
    // Providers that don't surface a usage block (or daemons predating
    // migration 260) write null. Coercing to `{}` would be
    // indistinguishable from a usage block that genuinely has no fields,
    // so we preserve null as the "absent" signal.
    recordUsageEvent(
      makeInput({ provider: "openai", model: "gpt-4o", rawUsage: null }),
      pricedResult,
    );

    const [event] = listUsageEvents();
    expect(event.rawUsage).toBeNull();
  });

  test("round-trips cronRunId through SQLite", () => {
    const event = recordUsageEvent(
      makeInput({ cronRunId: "cron-run-1" }),
      pricedResult,
    );
    expect(event.cronRunId).toBe("cron-run-1");

    const row = getSqlite()
      .query("SELECT cron_run_id FROM llm_usage_events WHERE id = ?")
      .get(event.id) as { cron_run_id: string | null } | null;
    expect(row?.cron_run_id).toBe("cron-run-1");

    // listUsageEvents routes through rowToUsageEvent; cronRunId must survive it.
    const [typed] = listUsageEvents();
    expect(typed?.cronRunId).toBe("cron-run-1");
  });

  test("cronRunId defaults to null when omitted", () => {
    const event = recordUsageEvent(makeInput(), pricedResult);
    expect(event.cronRunId ?? null).toBeNull();

    const row = getSqlite()
      .query("SELECT cron_run_id FROM llm_usage_events WHERE id = ?")
      .get(event.id) as { cron_run_id: string | null } | null;
    expect(row?.cron_run_id).toBeNull();
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

describe("listRunConversationIds", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  /** Record an event for a conversation, stamped with the given cron run id. */
  function insertRunEvent(
    cronRunId: string,
    conversationId: string | null,
  ): void {
    const event = recordUsageEvent(makeInput({ conversationId }), pricedResult);
    const db = getDb();
    db.run(
      `UPDATE llm_usage_events SET cron_run_id = '${cronRunId}' WHERE id = '${event.id}'`,
    );
  }

  test("returns the distinct conversation ids a firing touched (deduped)", () => {
    insertRunEvent("run-1", "conv-a");
    insertRunEvent("run-1", "conv-a"); // same conversation, second LLM call
    insertRunEvent("run-1", "conv-b");

    expect(listRunConversationIds("run-1").sort()).toEqual([
      "conv-a",
      "conv-b",
    ]);
  });

  test("returns an empty array for an unknown run", () => {
    insertRunEvent("run-1", "conv-a");
    expect(listRunConversationIds("run-unknown")).toEqual([]);
  });

  test("ignores rows with no conversation id and other runs", () => {
    insertRunEvent("run-1", "conv-a");
    insertRunEvent("run-1", null); // memory consolidation etc.
    insertRunEvent("run-2", "conv-b");

    expect(listRunConversationIds("run-1")).toEqual(["conv-a"]);
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

describe("usage aggregation schedule filters", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
    db.run(`DELETE FROM cron_runs`);
    db.run(`DELETE FROM cron_jobs`);
  });

  function insertScheduleJob(id: string, name: string): void {
    const now = Date.UTC(2026, 0, 1);
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

  function insertStampedEventAt(
    timestamp: number,
    cronRunId: string,
    inputOverrides?: Partial<UsageEventInput>,
    pricing: PricingResult = pricedResult,
  ): void {
    const event = recordUsageEvent(makeInput(inputOverrides), pricing);
    getSqlite().run(
      `UPDATE llm_usage_events SET created_at = ?, cron_run_id = ? WHERE id = ?`,
      [timestamp, cronRunId, event.id],
    );
  }

  function seedScheduleUsage(): void {
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

    insertEventAt(
      900,
      { conversationId: "conv-reused", inputTokens: 90 },
      { estimatedCostUsd: 0.09, pricingStatus: "priced" },
    );
    insertEventAt(
      1_000,
      {
        conversationId: "conv-reused",
        callSite: "mainAgent",
        inputTokens: 100,
      },
      { estimatedCostUsd: 0.1, pricingStatus: "priced" },
    );
    insertEventAt(
      1_500,
      {
        conversationId: "conv-reused",
        callSite: "mainAgent",
        inputTokens: 200,
      },
      { estimatedCostUsd: 0.2, pricingStatus: "priced" },
    );
    insertEventAt(
      2_000,
      {
        conversationId: "conv-reused",
        callSite: "mainAgent",
        inputTokens: 300,
      },
      { estimatedCostUsd: 0.3, pricingStatus: "priced" },
    );
    insertEventAt(
      2_500,
      { conversationId: "conv-reused", inputTokens: 400 },
      { estimatedCostUsd: 0.4, pricingStatus: "priced" },
    );
    insertEventAt(
      3_200,
      {
        conversationId: "conv-reused",
        provider: "openai",
        inputTokens: 500,
      },
      { estimatedCostUsd: 0.5, pricingStatus: "priced" },
    );
    insertEventAt(
      1_500,
      { conversationId: "conv-other", inputTokens: 800 },
      { estimatedCostUsd: 0.8, pricingStatus: "priced" },
    );
  }

  test("filters totals, buckets, breakdowns, and series by cron run windows", () => {
    seedScheduleUsage();
    const range = { from: 0, to: 4_000 };
    const filter = { scheduleId: "schedule-a" };

    const totals = getUsageTotals(range, filter);
    expect(totals.eventCount).toBe(3);
    expect(totals.totalInputTokens).toBe(600);
    expect(totals.totalEstimatedCostUsd).toBeCloseTo(0.6);

    const dailyBuckets = getUsageDayBuckets(range, "UTC", {}, filter);
    expect(dailyBuckets).toHaveLength(1);
    expect(dailyBuckets[0].totalInputTokens).toBe(600);
    expect(dailyBuckets[0].eventCount).toBe(3);

    const hourlyBuckets = getUsageHourBuckets(range, "UTC", {}, filter);
    expect(hourlyBuckets).toHaveLength(1);
    expect(hourlyBuckets[0].totalInputTokens).toBe(600);
    expect(hourlyBuckets[0].eventCount).toBe(3);

    const breakdown = getUsageGroupBreakdown(range, "provider", filter);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].group).toBe("anthropic");
    expect(breakdown[0].totalInputTokens).toBe(600);
    expect(breakdown[0].eventCount).toBe(3);

    const series = getUsageGroupedSeries(
      range,
      "call_site",
      "daily",
      "UTC",
      {},
      filter,
    );
    expect(series).toHaveLength(1);
    expect(series[0].totalInputTokens).toBe(600);
    expect(series[0].groups["null:call_site"]).toBeUndefined();
    expect(series[0].groups["null:schedule"]).toBeUndefined();
    expect(series[0].groups["value:mainAgent"]).toMatchObject({
      group: "Main Agent",
      totalInputTokens: 600,
      eventCount: 3,
    });
  });

  test("groups schedule-attributed usage by schedule id with schedule names", () => {
    seedScheduleUsage();
    const range = { from: 0, to: 4_000 };

    const breakdown = getUsageGroupBreakdown(range, "schedule");
    const scheduleA = breakdown.find((row) => row.groupKey === "schedule-a");
    const scheduleB = breakdown.find((row) => row.groupKey === "schedule-b");
    const other = breakdown.find((row) => row.groupKey === null);

    expect(scheduleA).toMatchObject({
      group: "Morning summary",
      groupId: "schedule-a",
      groupKey: "schedule-a",
      totalInputTokens: 600,
      eventCount: 3,
    });
    expect(scheduleB).toMatchObject({
      group: "Nightly sync",
      groupId: "schedule-b",
      groupKey: "schedule-b",
      totalInputTokens: 500,
      eventCount: 1,
    });
    expect(other).toMatchObject({
      group: "Other",
      groupId: null,
      groupKey: null,
      totalInputTokens: 1_290,
      eventCount: 3,
    });

    const series = getUsageGroupedSeries(range, "schedule", "daily", "UTC", {});
    expect(series).toHaveLength(1);
    expect(series[0].groups["value:schedule-a"]).toMatchObject({
      group: "Morning summary",
      groupKey: "schedule-a",
      totalInputTokens: 600,
      eventCount: 3,
    });
    expect(series[0].groups["value:schedule-b"]).toMatchObject({
      group: "Nightly sync",
      groupKey: "schedule-b",
      totalInputTokens: 500,
      eventCount: 1,
    });
    expect(series[0].groups["null:schedule"]).toMatchObject({
      group: "Other",
      groupKey: null,
      totalInputTokens: 1_290,
      eventCount: 3,
    });
  });

  test("attributes a cron_run_id-stamped row to its firing's schedule and keeps legacy windowed rows", () => {
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

    // Legacy row: null cron_run_id, attributed to schedule-a via the conversation + window match.
    insertEventAt(
      1_500,
      { conversationId: "conv-reused", inputTokens: 100 },
      { estimatedCostUsd: 0.1, pricingStatus: "priced" },
    );

    // Stamped row: cron_run_id pins it to schedule-a's firing even though it is
    // outside every run window and on a conversation no run references.
    insertStampedEventAt(
      9_999,
      "run-a-1",
      { conversationId: "conv-script", inputTokens: 50 },
      { estimatedCostUsd: 0.05, pricingStatus: "priced" },
    );

    const range = { from: 0, to: 10_000 };
    const breakdown = getUsageGroupBreakdown(range, "schedule");
    const scheduleA = breakdown.find((row) => row.groupKey === "schedule-a");
    const scheduleB = breakdown.find((row) => row.groupKey === "schedule-b");

    expect(scheduleA).toMatchObject({
      groupId: "schedule-a",
      groupKey: "schedule-a",
      totalInputTokens: 150,
      eventCount: 2,
    });
    // The stamped row neither leaks into schedule-b's later window nor lands in "Other".
    expect(scheduleB).toBeUndefined();
    expect(breakdown.find((row) => row.groupKey === null)).toBeUndefined();
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

  test("collapses many events within a sub-bucket span without losing totals", () => {
    // The read path pre-aggregates events into 15-minute UTC buckets in SQL
    // before local-time bucketing. Many events inside one such window must
    // still sum exactly, and events split across the 15-minute boundary but
    // within the same local day must land in the same day bucket.
    const windowStart = utcMs(2025, 3, 1, 10); // 10:00:00 UTC
    for (let i = 0; i < 50; i++) {
      // Spread across ~16 minutes so the events straddle a 15-minute boundary.
      insertEventAt(windowStart + i * 20_000, {
        inputTokens: 2,
        outputTokens: 1,
      });
    }

    const buckets = getUsageDayBuckets({
      from: utcMs(2025, 3, 1),
      to: utcMs(2025, 3, 2),
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].date).toBe("2025-03-01");
    expect(buckets[0].totalInputTokens).toBe(100);
    expect(buckets[0].totalOutputTokens).toBe(50);
    expect(buckets[0].eventCount).toBe(50);
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

  test("DST spring forward: mid-day `from` anchors correctly to local midnight", () => {
    // America/Los_Angeles 2026-03-08 spring-forward: 02:00 PST -> 03:00 PDT.
    // Naive day alignment (subtract current wall-clock hours from epoch)
    // would misplace events around the transition when `from` is mid-day on
    // the transition day. (PR #24722 review feedback from Codex.)

    // Event at 17:00 UTC = 10:00 PDT on 2026-03-08 (post-DST).
    insertEventAt(Date.UTC(2026, 2, 8, 17), { inputTokens: 500 });
    // Event at 23:00 UTC = 16:00 PDT on 2026-03-08 (post-DST).
    insertEventAt(Date.UTC(2026, 2, 8, 23), { inputTokens: 700 });
    // Event at 06:00 UTC = 22:00 PST on 2026-03-07 (pre-DST, previous local day).
    insertEventAt(Date.UTC(2026, 2, 8, 6), { inputTokens: 300 });

    // `from` is mid-day on the transition day.
    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 2, 8, 18), to: Date.UTC(2026, 2, 9, 23) },
      "America/Los_Angeles",
      { fillEmpty: true },
    );

    // fillEmpty should seed a 2026-03-08 bucket aligned to 08:00 UTC (local
    // midnight PST) — not to some post-transition offset that yields a prior
    // local day. No "2026-03-07" bucket should appear.
    const dates = buckets.map((b) => b.date);
    expect(dates).not.toContain("2026-03-07");
    expect(dates).toContain("2026-03-08");
    // The 23:00-UTC event on March 8 must land in the 2026-03-08 bucket, not
    // drift into 2026-03-09 due to offset/midnight misalignment.
    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    // Events inserted at 17:00 and 23:00 UTC on March 8 are both after `from`
    // (18:00 UTC) only for the second one; we mainly care that the 23:00-UTC
    // event correctly lands on March 8 local.
    expect(map["2026-03-08"]?.totalInputTokens).toBeGreaterThanOrEqual(700);
  });

  test("DST spring forward: day-midnight alignment works across the jump", () => {
    // Direct regression test: an event at the FIRST moment of post-DST (just
    // after 03:00 PDT = 10:00 UTC) on 2026-03-08 should bucket to 2026-03-08,
    // not 2026-03-07.
    insertEventAt(Date.UTC(2026, 2, 8, 10, 1), { inputTokens: 42 });

    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 2, 8, 10), to: Date.UTC(2026, 2, 9, 0) },
      "America/Los_Angeles",
    );

    const map = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(map["2026-03-08"]?.totalInputTokens).toBe(42);
    expect(map["2026-03-07"]).toBeUndefined();
  });

  test("bucketId: daily bucketId equals the date string", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 12), { inputTokens: 10 });
    const buckets = getUsageDayBuckets(
      { from: Date.UTC(2026, 3, 10, 0), to: Date.UTC(2026, 3, 10, 23) },
      "UTC",
    );
    expect(buckets[0].bucketId).toBe(buckets[0].date);
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
    // But their bucketIds MUST be distinct so SwiftUI ForEach(id:\.bucketId)
    // doesn't collapse them. (PR #24722 review feedback from Codex.)
    expect(oneAmBuckets[0].bucketId).not.toBe(oneAmBuckets[1].bucketId);
    expect(oneAmBuckets.map((b) => b.bucketId).sort()).toEqual([
      "2026-11-01 01:00|-240",
      "2026-11-01 01:00|-300",
    ]);
    // Daily/non-dup-hour bucketIds default to the date key.
    const nonDupHour = buckets.find((b) => b.date === "2026-11-01 00:00");
    if (nonDupHour) {
      expect(nonDupHour.bucketId).toBe(`${nonDupHour.date}|-240`);
    }
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
    db.run(`DELETE FROM conversations`);
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

  test("groups by call site with display labels and raw group keys", () => {
    insertEventAt(
      1000,
      { callSite: "mainAgent", inputTokens: 100 },
      { estimatedCostUsd: 0.03, pricingStatus: "priced" },
    );
    insertEventAt(
      2000,
      { callSite: "conversationTitle", inputTokens: 200 },
      { estimatedCostUsd: 0.01, pricingStatus: "priced" },
    );
    insertEventAt(
      3000,
      { callSite: null, inputTokens: 300 },
      { estimatedCostUsd: 0.02, pricingStatus: "priced" },
    );

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "call_site");
    expect(groups.map((group) => group.group)).toEqual([
      "Main Agent",
      "Unknown Task",
      "Conversation Title",
    ]);
    expect(groups.map((group) => group.groupKey)).toEqual([
      "mainAgent",
      null,
      "conversationTitle",
    ]);
    expect(
      groups.find((group) => group.groupKey === null)?.totalInputTokens,
    ).toBe(300);
  });

  test("groups by inference profile with unset historical rows preserved", () => {
    insertEventAt(
      1000,
      { inferenceProfile: "fast", inputTokens: 100 },
      { estimatedCostUsd: 0.01, pricingStatus: "priced" },
    );
    insertEventAt(
      2000,
      { inferenceProfile: null, inputTokens: 200 },
      { estimatedCostUsd: 0.02, pricingStatus: "priced" },
    );

    const groups = getUsageGroupBreakdown(
      { from: 0, to: 5000 },
      "inference_profile",
    );
    expect(groups.map((group) => group.group)).toEqual([
      "Default / Unset",
      "fast",
    ]);
    expect(groups.map((group) => group.groupKey)).toEqual([null, "fast"]);
    expect(groups[0].totalInputTokens).toBe(200);
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

  test("returns groupId matching the seeded conversation id when grouping by conversation", () => {
    const db = getDb();
    const conversationId = "conv-breakdown-1";
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${conversationId}', 'Debug session', ${now}, ${now})`,
    );

    insertEventAt(
      1000,
      { conversationId, inputTokens: 100, outputTokens: 50 },
      { estimatedCostUsd: 0.02, pricingStatus: "priced" },
    );
    insertEventAt(
      2000,
      { conversationId, inputTokens: 200, outputTokens: 75 },
      { estimatedCostUsd: 0.03, pricingStatus: "priced" },
    );

    const groups = getUsageGroupBreakdown(
      { from: 0, to: 5000 },
      "conversation",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe("Debug session");
    expect(groups[0].groupId).toBe(conversationId);
    expect(groups[0].totalInputTokens).toBe(300);
    expect(groups[0].totalOutputTokens).toBe(125);
    expect(groups[0].totalEstimatedCostUsd).toBeCloseTo(0.05);
    expect(groups[0].eventCount).toBe(2);
    // No user messages were inserted, so the conversation has zero turns.
    expect(groups[0].turnCount).toBe(0);
  });

  test("counts conversation turns from eligible user messages when grouping by conversation", () => {
    const db = getDb();
    const conversationId = "conv-turns-1";
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${conversationId}', 'Turn counting', ${now}, ${now})`,
    );
    // Two user turns; the second turn has two LLM calls, but the count comes
    // from the user messages (2), not the number of LLM calls (3).
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('u1', '${conversationId}', 'user', 'first', 500)`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('u2', '${conversationId}', 'user', 'second', 2000)`,
    );
    // Tool-result user messages are not real turns and must be excluded.
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('tr1', '${conversationId}', 'user', '[{"type":"tool_result","tool_use_id":"x","content":""}]', 2100)`,
    );
    insertEventAt(1000, { conversationId, inputTokens: 100 });
    insertEventAt(2500, { conversationId, inputTokens: 100 });
    insertEventAt(2600, { conversationId, inputTokens: 100 });

    const groups = getUsageGroupBreakdown(
      { from: 0, to: 5000 },
      "conversation",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe(conversationId);
    expect(groups[0].eventCount).toBe(3);
    expect(groups[0].turnCount).toBe(2);
  });

  test("returns groupId null for the Other bucket when grouping by conversation and events have no conversation id", () => {
    insertEventAt(
      1000,
      { conversationId: null, inputTokens: 100 },
      { estimatedCostUsd: 0.01, pricingStatus: "priced" },
    );
    insertEventAt(
      2000,
      { conversationId: null, inputTokens: 200 },
      { estimatedCostUsd: 0.02, pricingStatus: "priced" },
    );

    const groups = getUsageGroupBreakdown(
      { from: 0, to: 5000 },
      "conversation",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe("Other");
    expect(groups[0].groupId).toBeNull();
    expect(groups[0].totalInputTokens).toBe(300);
    expect(groups[0].eventCount).toBe(2);
    // The Other bucket has no parent conversation, so turns are undefined.
    expect(groups[0].turnCount).toBeNull();
  });

  test("returns groupId null for every row when grouping by a non-conversation dimension", () => {
    insertEventAt(
      1000,
      { model: "claude-sonnet-4-20250514", conversationId: "conv-a" },
      { estimatedCostUsd: 0.03, pricingStatus: "priced" },
    );
    insertEventAt(
      2000,
      { model: "claude-sonnet-4-20250514", conversationId: "conv-b" },
      { estimatedCostUsd: 0.02, pricingStatus: "priced" },
    );
    insertEventAt(3000, { model: "llama3" }, unpricedResult);

    const groups = getUsageGroupBreakdown({ from: 0, to: 5000 }, "model");
    expect(groups.length).toBeGreaterThan(0);
    for (const row of groups) {
      expect(row.groupId).toBeNull();
      // Turns are only computed for the conversation grouping.
      expect(row.turnCount).toBeNull();
    }
  });
});

describe("getUsageGroupedSeries", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("returns grouped daily buckets keyed by call-site ids", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 10), {
      callSite: "mainAgent",
      inputTokens: 100,
      outputTokens: 10,
    });
    insertEventAt(Date.UTC(2026, 3, 10, 12), {
      callSite: "conversationTitle",
      inputTokens: 200,
      outputTokens: 20,
    });
    insertEventAt(Date.UTC(2026, 3, 11, 10), {
      callSite: null,
      inputTokens: 300,
      outputTokens: 30,
    });

    const buckets = getUsageGroupedSeries(
      {
        from: Date.UTC(2026, 3, 10, 0),
        to: Date.UTC(2026, 3, 11, 23),
      },
      "call_site",
      "daily",
      "UTC",
      { fillEmpty: true },
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[0].groups["value:mainAgent"]).toMatchObject({
      group: "Main Agent",
      groupKey: "mainAgent",
      totalInputTokens: 100,
    });
    expect(buckets[0].groups["value:conversationTitle"]).toMatchObject({
      group: "Conversation Title",
      groupKey: "conversationTitle",
      totalInputTokens: 200,
    });
    expect(buckets[1].groups["null:call_site"]).toMatchObject({
      group: "Unknown Task",
      groupKey: null,
      totalInputTokens: 300,
    });
  });

  test("returns grouped hourly buckets by inference profile including unset rows", () => {
    insertEventAt(Date.UTC(2026, 3, 10, 10, 15), {
      inferenceProfile: "fast",
      inputTokens: 100,
    });
    insertEventAt(Date.UTC(2026, 3, 10, 10, 45), {
      inferenceProfile: null,
      inputTokens: 200,
    });

    const buckets = getUsageGroupedSeries(
      {
        from: Date.UTC(2026, 3, 10, 10),
        to: Date.UTC(2026, 3, 10, 11),
      },
      "inference_profile",
      "hourly",
      "UTC",
      { fillEmpty: true },
    );

    const bucket = buckets.find((entry) => entry.date === "2026-04-10 10:00");
    expect(bucket?.groups["value:fast"]).toMatchObject({
      group: "fast",
      groupKey: "fast",
      totalInputTokens: 100,
    });
    expect(bucket?.groups["null:inference_profile"]).toMatchObject({
      group: "Default / Unset",
      groupKey: null,
      totalInputTokens: 200,
    });
  });

  test("orders grouped hourly buckets chronologically across positive-offset fall back", () => {
    insertEventAt(Date.UTC(2026, 3, 4, 15, 15), {
      inferenceProfile: "first-hour",
      inputTokens: 100,
    });
    insertEventAt(Date.UTC(2026, 3, 4, 16, 15), {
      inferenceProfile: "second-hour",
      inputTokens: 200,
    });

    const buckets = getUsageGroupedSeries(
      {
        from: Date.UTC(2026, 3, 4, 15),
        to: Date.UTC(2026, 3, 4, 17),
      },
      "inference_profile",
      "hourly",
      "Australia/Sydney",
      { fillEmpty: true },
    );

    const duplicateTwoAmBuckets = buckets.filter(
      (entry) => entry.date === "2026-04-05 02:00",
    );
    expect(duplicateTwoAmBuckets.map((entry) => entry.bucketId)).toEqual([
      "2026-04-05 02:00|660",
      "2026-04-05 02:00|600",
    ]);
    expect(duplicateTwoAmBuckets[0].groups["value:first-hour"]).toMatchObject({
      group: "first-hour",
      totalInputTokens: 100,
    });
    expect(duplicateTwoAmBuckets[1].groups["value:second-hour"]).toMatchObject({
      group: "second-hour",
      totalInputTokens: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// queryUnreportedUsageEvents tests
// ---------------------------------------------------------------------------

describe("queryUnreportedUsageEvents", () => {
  beforeEach(() => {
    const db = getDb();
    // Order matters: clear `llm_usage_events` (no FK), then `messages`
    // (FK to conversations cascades, but be explicit), then
    // `conversations`. The conversation-level metadata tests below
    // depend on a clean conversations + messages slate so JOINs are
    // deterministic.
    db.run(`DELETE FROM llm_usage_events`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
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

  test("returns attribution fields for unreported usage events", () => {
    insertEventAt(1000, {
      callSite: "mainAgent",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
    });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    expect(events[0].callSite).toBe("mainAgent");
    expect(events[0].inferenceProfile).toBe("balanced");
    expect(events[0].inferenceProfileSource).toBe("active");
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

  // -------------------------------------------------------------------------
  // Conversation-level metadata (conversationType + turnIndex). These are
  // JOIN-computed at telemetry-query time so the reporter can emit them on
  // the wire without persisting extra columns on `llm_usage_events`.
  // -------------------------------------------------------------------------

  test("conversationType is JOINed from the conversations table", () => {
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('conv-std', 'standard', ${now}, ${now})`,
    );
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('conv-bg', 'background', ${now}, ${now})`,
    );

    insertEventAt(1000, { conversationId: "conv-std" });
    insertEventAt(2000, { conversationId: "conv-bg" });
    insertEventAt(3000, { conversationId: null });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(3);
    expect(events[0].conversationType).toBe("standard");
    expect(events[1].conversationType).toBe("background");
    // LLM calls without a parent conversation get null — LEFT JOIN, not INNER.
    expect(events[2].conversationType).toBeNull();
  });

  test("turnIndex counts real user turns up to the LLM call's createdAt", () => {
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('conv-1', 'standard', ${now}, ${now})`,
    );
    // Two user messages in the conversation.
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'conv-1', 'user', 'hello', 1000)`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m2', 'conv-1', 'user', 'follow up', 3000)`,
    );

    // Three LLM calls across the timeline:
    //  - mid-turn-1 (between m1 and m2)
    //  - exactly at m2's createdAt (still counts m2: `created_at <= e.created_at`)
    //  - after m2
    insertEventAt(2000, { conversationId: "conv-1" });
    insertEventAt(3000, { conversationId: "conv-1" });
    insertEventAt(4000, { conversationId: "conv-1" });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(3);
    expect(events[0].turnIndex).toBe(1);
    expect(events[1].turnIndex).toBe(2);
    expect(events[2].turnIndex).toBe(2);
  });

  test("turnIndex is null when the LLM call has no conversationId", () => {
    insertEventAt(1000, { conversationId: null });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBeNull();
    expect(events[0].turnIndex).toBeNull();
  });

  test("turnIndex skips tool_result rows when counting", () => {
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('conv-tr', 'standard', ${now}, ${now})`,
    );
    // One real user turn, then a tool_result row (which should be
    // ignored), then the LLM call. Expected turn_index = 1.
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('real-1', 'conv-tr', 'user', 'real text', 1000)`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('tool-1', 'conv-tr', 'user', '[{"type":"tool_result","tool_use_id":"x","content":""}]', 1500)`,
    );
    insertEventAt(2000, { conversationId: "conv-tr" });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    expect(events[0].turnIndex).toBe(1);
  });

  test("turnIndex is 0 when the LLM call fires before any user message", () => {
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO conversations (id, conversation_type, created_at, updated_at) VALUES ('conv-early', 'standard', ${now}, ${now})`,
    );
    // LLM call fires at t=1000; first user message is at t=2000.
    insertEventAt(1000, { conversationId: "conv-early" });
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('later', 'conv-early', 'user', 'hi', 2000)`,
    );

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    // Conversation exists but no user turn has fired yet. The CASE
    // short-circuits only on null conversationId, so we get a real 0.
    // Analytics can treat 0 as "pre-first-turn" if needed.
    expect(events[0].turnIndex).toBe(0);
  });

  test("surfaces llmCallCount on unreported events", () => {
    insertEventAt(1000, { llmCallCount: 4 });
    insertEventAt(2000, {});

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(2);
    expect(events[0].llmCallCount).toBe(4);
    // recordUsageEvent defaults llmCallCount to 1 when unset.
    expect(events[1].llmCallCount).toBe(1);
  });

  test("surfaces raw_usage on unreported events", () => {
    // The telemetry reporter consumes `queryUnreportedUsageEvents` output
    // directly and forwards it to BigQuery. If the SELECT projection
    // drops the `raw_usage` column, every provider-specific detail
    // (Anthropic TTL breakdown, OpenAI prompt-token details, etc.)
    // vanishes silently — covered here so a refactor of the projection
    // can't regress the wire shape.
    const rawUsage = {
      input_tokens: 1500,
      output_tokens: 600,
      cache_creation_input_tokens: 800,
      cache_creation: {
        ephemeral_5m_input_tokens: 300,
        ephemeral_1h_input_tokens: 500,
      },
    };
    insertEventAt(1000, {
      cacheCreationInputTokens: 800,
      rawUsage,
    });

    const events = queryUnreportedUsageEvents(0, undefined, 100);
    expect(events).toHaveLength(1);
    expect(events[0].cacheCreationInputTokens).toBe(800);
    expect(events[0].rawUsage).toEqual(rawUsage);
  });
});

// ---------------------------------------------------------------------------
// Record-time assistantVersion stamping (May 2026 telemetry honesty fix)
//
// Events buffered while the assistant is offline must remember the binary
// that was running when they were recorded, not the one that finally
// uploads them. recordUsageEvent stamps APP_VERSION at insert time and the
// query must return it so the reporter can put it on the wire.
// ---------------------------------------------------------------------------

describe("recordUsageEvent — assistantVersion stamping", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test("stamps APP_VERSION on the returned event", async () => {
    const { APP_VERSION } = await import("../version.js");
    const event = recordUsageEvent(makeInput(), pricedResult);
    expect(event.assistantVersion).toBe(APP_VERSION);
  });

  test("persists assistantVersion and queryUnreportedUsageEvents returns it", async () => {
    const { APP_VERSION } = await import("../version.js");
    insertEventAt(1000);
    const [event] = queryUnreportedUsageEvents(0, undefined, 100);
    expect(event).toBeDefined();
    expect(event.assistantVersion).toBe(APP_VERSION);
  });

  test("legacy rows (null assistant_version column) round-trip as null", () => {
    // Simulate a row that was persisted before migration 267 ran by
    // inserting one through recordUsageEvent and then nulling the
    // column out. This mirrors what production rows look like before
    // the migration backfills `null`s; the reporter must accept them
    // and let the platform fall back to the envelope's version.
    insertEventAt(1000);
    const db = getDb();
    db.run(`UPDATE llm_usage_events SET assistant_version = NULL`);

    const [event] = queryUnreportedUsageEvents(0, undefined, 100);
    expect(event).toBeDefined();
    expect(event.assistantVersion).toBeNull();
  });
});
