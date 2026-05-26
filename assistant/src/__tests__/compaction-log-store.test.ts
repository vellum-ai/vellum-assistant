/**
 * Tests for the `compaction-log-store` helpers — insert, fetch by
 * conversation, fetch recent, summary-excerpt truncation. Uses the real
 * SQLite db via `initializeDb()` so the schema, migration, and Drizzle
 * model agree.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  getCompactionLogsByConversation,
  getRecentCompactionLogs,
  type RecordCompactionLogInput,
  recordCompactionLog,
} from "../memory/compaction-log-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { compactionLogs } from "../memory/schema.js";

initializeDb();

function resetTable(): void {
  getDb().delete(compactionLogs).run();
}

function baseInput(
  overrides: Partial<RecordCompactionLogInput> = {},
): RecordCompactionLogInput {
  return {
    conversationId: "conv-base",
    llmRequestLogId: "log-123",
    mode: "normal",
    outcome: "compacted",
    beforeMessageCount: 30,
    afterMessageCount: 8,
    beforeEstimatedTokens: 90_000,
    afterEstimatedTokens: 12_000,
    maxInputTokens: 100_000,
    thresholdTokens: 70_000,
    summaryInputTokens: 5_000,
    summaryOutputTokens: 1_200,
    model: "gpt-test",
    latencyMs: 4321,
    errorMessage: null,
    summaryExcerpt: "the actual compressed summary text",
    ...overrides,
  };
}

describe("recordCompactionLog", () => {
  beforeEach(resetTable);

  test("inserts a row and returns the generated id", () => {
    const id = recordCompactionLog(baseInput());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const rows = getRecentCompactionLogs();
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(id);
  });

  test("round-trips every field accurately", () => {
    const id = recordCompactionLog(baseInput({ conversationId: "conv-rt" }));
    const rows = getCompactionLogsByConversation("conv-rt");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.id).toBe(id);
    expect(row.conversationId).toBe("conv-rt");
    expect(row.llmRequestLogId).toBe("log-123");
    expect(row.mode).toBe("normal");
    expect(row.outcome).toBe("compacted");
    expect(row.beforeMessageCount).toBe(30);
    expect(row.afterMessageCount).toBe(8);
    expect(row.beforeEstimatedTokens).toBe(90_000);
    expect(row.afterEstimatedTokens).toBe(12_000);
    expect(row.maxInputTokens).toBe(100_000);
    expect(row.thresholdTokens).toBe(70_000);
    expect(row.summaryInputTokens).toBe(5_000);
    expect(row.summaryOutputTokens).toBe(1_200);
    expect(row.model).toBe("gpt-test");
    expect(row.latencyMs).toBe(4321);
    expect(row.errorMessage).toBe(null);
    expect(row.summaryExcerpt).toBe("the actual compressed summary text");
    expect(typeof row.createdAt).toBe("number");
  });

  test("truncates summary excerpts beyond the cap", () => {
    const huge = "x".repeat(5_000);
    recordCompactionLog(baseInput({ summaryExcerpt: huge }));
    const rows = getRecentCompactionLogs();
    // Cap is 1000; the row must reflect that.
    expect(rows[0]!.summaryExcerpt?.length).toBe(1000);
  });

  test("accepts null summaryExcerpt for failure outcomes", () => {
    recordCompactionLog(
      baseInput({
        outcome: "provider_error",
        model: null,
        summaryExcerpt: null,
        errorMessage: "provider exploded",
      }),
    );
    const rows = getRecentCompactionLogs();
    expect(rows[0]!.summaryExcerpt).toBe(null);
    expect(rows[0]!.model).toBe(null);
    expect(rows[0]!.errorMessage).toBe("provider exploded");
  });

  test("accepts null llmRequestLogId (provider didn't return raw payloads)", () => {
    recordCompactionLog(baseInput({ llmRequestLogId: null }));
    const rows = getRecentCompactionLogs();
    expect(rows[0]!.llmRequestLogId).toBe(null);
  });
});

describe("getCompactionLogsByConversation", () => {
  beforeEach(resetTable);

  test("returns oldest-first per conversation", () => {
    const t0 = Date.now();
    recordCompactionLog(
      baseInput({ conversationId: "conv-a", createdAt: t0 + 100 }),
    );
    recordCompactionLog(
      baseInput({ conversationId: "conv-a", createdAt: t0 + 50 }),
    );
    recordCompactionLog(
      baseInput({ conversationId: "conv-b", createdAt: t0 + 200 }),
    );

    const aRows = getCompactionLogsByConversation("conv-a");
    expect(aRows.length).toBe(2);
    expect(aRows[0]!.createdAt).toBe(t0 + 50);
    expect(aRows[1]!.createdAt).toBe(t0 + 100);

    const bRows = getCompactionLogsByConversation("conv-b");
    expect(bRows.length).toBe(1);
  });

  test("honors since/until window + limit", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      recordCompactionLog(
        baseInput({ conversationId: "conv-window", createdAt: base + i * 10 }),
      );
    }

    const windowed = getCompactionLogsByConversation("conv-window", {
      since: base + 10,
      until: base + 30,
    });
    expect(windowed.map((r) => r.createdAt)).toEqual([
      base + 10,
      base + 20,
      base + 30,
    ]);

    const limited = getCompactionLogsByConversation("conv-window", {
      limit: 2,
    });
    expect(limited.length).toBe(2);
    expect(limited[0]!.createdAt).toBe(base);
    expect(limited[1]!.createdAt).toBe(base + 10);
  });
});

describe("getRecentCompactionLogs", () => {
  beforeEach(resetTable);

  test("returns newest-first across conversations", () => {
    const t0 = Date.now();
    recordCompactionLog(baseInput({ conversationId: "c1", createdAt: t0 }));
    recordCompactionLog(
      baseInput({ conversationId: "c2", createdAt: t0 + 100 }),
    );
    recordCompactionLog(
      baseInput({ conversationId: "c3", createdAt: t0 + 50 }),
    );

    const rows = getRecentCompactionLogs();
    expect(rows.map((r) => r.conversationId)).toEqual(["c2", "c3", "c1"]);
  });

  test("respects the limit", () => {
    for (let i = 0; i < 10; i++) {
      recordCompactionLog(
        baseInput({ conversationId: `c-${i}`, createdAt: Date.now() + i }),
      );
    }
    expect(getRecentCompactionLogs(3).length).toBe(3);
  });
});
