/**
 * Tests for the `call_site` column on `llm_request_logs`. The column is
 * stamped by `recordRequestLog` at insertion time and surfaces in
 * `LogRow.callSite`. Historical rows (pre-migration 264) stay NULL —
 * "we don't know" rather than guessing `mainAgent`.
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

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getRequestLogById,
  recordRequestLog,
} from "../memory/llm-request-log-store.js";
import { migrateLlmRequestLogCallSite } from "../memory/migrations/264-llm-request-log-call-site.js";
import { llmRequestLogs } from "../memory/schema.js";

initializeDb();

function resetLogs(): void {
  const db = getDb();
  db.delete(llmRequestLogs).run();
}

describe("recordRequestLog call_site stamping", () => {
  beforeEach(resetLogs);

  test("stamps callSite when provided", () => {
    const id = recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    const row = getRequestLogById(id);
    expect(row).not.toBeNull();
    expect(row!.callSite).toBe("mainAgent");
  });

  test("leaves callSite NULL when omitted (backward compat)", () => {
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    const row = getRequestLogById(id);
    expect(row).not.toBeNull();
    expect(row!.callSite).toBeNull();
  });

  test("supports the compactionAgent value", () => {
    const id = recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "compactionAgent",
    );
    expect(getRequestLogById(id)?.callSite).toBe("compactionAgent");
  });

  test("two rows in the same conversation can carry different callSites", () => {
    const mainId = recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    const compactId = recordRequestLog(
      "conv-1",
      '{"req":2}',
      '{"res":2}',
      undefined,
      "anthropic",
      "compactionAgent",
    );
    expect(getRequestLogById(mainId)?.callSite).toBe("mainAgent");
    expect(getRequestLogById(compactId)?.callSite).toBe("compactionAgent");
  });
});

describe("migrateLlmRequestLogCallSite", () => {
  test("adds the call_site column when missing", () => {
    const db = getDb();
    const raw = getSqliteFrom(db);

    // Drop the column if present (simulate pre-264 state). SQLite supports
    // `DROP COLUMN` since 3.35 (June 2021) — bun-sqlite ships well past that.
    const before = raw
      .query(`PRAGMA table_info(llm_request_logs)`)
      .all() as Array<{ name: string }>;
    if (before.some((c) => c.name === "call_site")) {
      raw.exec(`ALTER TABLE llm_request_logs DROP COLUMN call_site`);
    }

    const without = raw
      .query(`PRAGMA table_info(llm_request_logs)`)
      .all() as Array<{ name: string }>;
    expect(without.some((c) => c.name === "call_site")).toBe(false);

    migrateLlmRequestLogCallSite(db);

    const after = raw
      .query(`PRAGMA table_info(llm_request_logs)`)
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "call_site")).toBe(true);
  });

  test("is idempotent — second run is a no-op", () => {
    const db = getDb();
    // First run (column may or may not exist depending on test order; either
    // path is fine for the idempotency contract).
    migrateLlmRequestLogCallSite(db);
    // Second run must not throw.
    expect(() => migrateLlmRequestLogCallSite(db)).not.toThrow();
  });
});
