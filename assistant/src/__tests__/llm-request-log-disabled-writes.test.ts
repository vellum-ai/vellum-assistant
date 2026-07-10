/**
 * Tests the master switch for LLM request logging (`llmRequestLogs.enabled`).
 * When logging is off, the store's insert paths (`recordRequestLog`,
 * `recordSyntheticAgentErrorMessageLog`) must skip the write entirely — no
 * prompt/completion payload lands on disk — and return `null`. The read-side
 * 4xx is exercised separately at the route layer.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable so each test toggles the flag the store reads via `getConfigReadOnly`.
let enabled = true;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llmRequestLogs: { readSource: "local", enabled },
  }),
  getConfigReadOnly: () => ({
    llmRequestLogs: { readSource: "local", enabled },
  }),
}));

// `mock.module()` persists process-wide; reset so other files don't inherit a
// stale value.
afterAll(() => {
  enabled = true;
});

import { getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getRequestLogById,
  getRequestLogsByConversationId,
  recordRequestLog,
  recordSyntheticAgentErrorMessageLog,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs } from "../persistence/schema/index.js";

await initializeDb();

function resetLogs(): void {
  getLogsDb()!.delete(llmRequestLogs).run();
}

describe("llmRequestLogs.enabled write gate", () => {
  beforeEach(() => {
    resetLogs();
    enabled = true;
  });

  test("recordRequestLog writes normally when logging is enabled", () => {
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).not.toBeNull();
    expect(getRequestLogById(id!)).not.toBeNull();
  });

  test("recordRequestLog skips the write when logging is disabled", () => {
    enabled = false;
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).toBeNull();
    expect(getRequestLogsByConversationId("conv-1")).toEqual([]);
  });

  test("recordSyntheticAgentErrorMessageLog skips the write when disabled", () => {
    enabled = false;
    const id = recordSyntheticAgentErrorMessageLog({
      conversationId: "conv-2",
      messageId: "msg-2",
      exitReason: "budget_yield_unrecovered",
      noticeText: "Out of budget.",
      preparedRequest: null,
      createdAt: Date.now(),
    });
    expect(id).toBeNull();
    expect(getRequestLogsByConversationId("conv-2")).toEqual([]);
  });

  test("re-enabling logging restores writes", () => {
    enabled = false;
    expect(recordRequestLog("conv-3", '{"req":1}', '{"res":1}')).toBeNull();
    enabled = true;
    const id = recordRequestLog("conv-3", '{"req":2}', '{"res":2}');
    expect(id).not.toBeNull();
    expect(getRequestLogsByConversationId("conv-3")).toHaveLength(1);
  });
});
