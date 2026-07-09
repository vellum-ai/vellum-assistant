/**
 * Tests the master opt-out for LLM request logging
 * (`llmRequestLogs.disabled`). When disabled, the store's insert paths
 * (`recordRequestLog`, `recordSyntheticAgentErrorMessageLog`) must skip the
 * write entirely — no prompt/completion payload lands on disk — and return an
 * empty id. The read-side 4xx is exercised separately at the route layer.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable so each test toggles the flag the store reads via `getConfigReadOnly`.
let disabled = false;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llmRequestLogs: { readSource: "local", disabled },
  }),
  getConfigReadOnly: () => ({
    llmRequestLogs: { readSource: "local", disabled },
  }),
}));

// `mock.module()` persists process-wide; reset so other files don't inherit a
// stale disabled state.
afterAll(() => {
  disabled = false;
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

describe("llmRequestLogs.disabled write gate", () => {
  beforeEach(() => {
    resetLogs();
    disabled = false;
  });

  test("recordRequestLog writes normally when logging is enabled", () => {
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).not.toBe("");
    expect(getRequestLogById(id)).not.toBeNull();
  });

  test("recordRequestLog skips the write when logging is disabled", () => {
    disabled = true;
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).toBe("");
    expect(getRequestLogsByConversationId("conv-1")).toEqual([]);
  });

  test("recordSyntheticAgentErrorMessageLog skips the write when disabled", () => {
    disabled = true;
    const id = recordSyntheticAgentErrorMessageLog({
      conversationId: "conv-2",
      messageId: "msg-2",
      exitReason: "budget_yield_unrecovered",
      noticeText: "Out of budget.",
      preparedRequest: null,
      createdAt: Date.now(),
    });
    expect(id).toBe("");
    expect(getRequestLogsByConversationId("conv-2")).toEqual([]);
  });

  test("re-enabling logging restores writes", () => {
    disabled = true;
    expect(recordRequestLog("conv-3", '{"req":1}', '{"res":1}')).toBe("");
    disabled = false;
    const id = recordRequestLog("conv-3", '{"req":2}', '{"res":2}');
    expect(id).not.toBe("");
    expect(getRequestLogsByConversationId("conv-3")).toHaveLength(1);
  });
});
