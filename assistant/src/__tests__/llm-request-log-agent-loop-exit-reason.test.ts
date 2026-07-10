/**
 * Tests for `setAgentLoopExitReasonOnLatestLog` and the
 * `agentLoopExitReason` field on the LogRow type. The helper stamps the
 * reason onto the most-recent `llm_request_logs` row for a conversation,
 * which is how downstream tooling distinguishes "loop kept going" (null)
 * from "loop exited because X" (specific reason) on a per-row basis.
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

import { getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getRequestLogById,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs } from "../persistence/schema/index.js";

await initializeDb();

// llm_request_logs lives in the dedicated logs connection.
function resetLogs(): void {
  getLogsDb()!.delete(llmRequestLogs).run();
}

describe("setAgentLoopExitReasonOnLatestLog", () => {
  beforeEach(resetLogs);

  test("recordRequestLog leaves agentLoopExitReason NULL", () => {
    const id = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    const row = getRequestLogById(id!);
    expect(row).not.toBeNull();
    expect(row!.agentLoopExitReason).toBeNull();
  });

  test("stamps the reason onto the most-recent log for the conversation", () => {
    const first = recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    // Ensure createdAt strict ordering — `recordRequestLog` uses
    // `Date.now()` and bun-sqlite is fast enough that two consecutive
    // inserts can share a millisecond. Sleep a tick to disambiguate.
    Bun.sleepSync(2);
    const second = recordRequestLog("conv-1", '{"req":2}', '{"res":2}');

    setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");

    expect(getRequestLogById(first!)?.agentLoopExitReason).toBeNull();
    expect(getRequestLogById(second!)?.agentLoopExitReason).toBe(
      "no_tool_calls",
    );
  });

  test("scopes the stamp to the given conversation only", () => {
    const a = recordRequestLog("conv-a", '{"req":1}', '{"res":1}');
    Bun.sleepSync(2);
    const b = recordRequestLog("conv-b", '{"req":1}', '{"res":1}');

    setAgentLoopExitReasonOnLatestLog("conv-a", "yield_to_user");

    expect(getRequestLogById(a!)?.agentLoopExitReason).toBe("yield_to_user");
    // conv-b is later overall but belongs to a different conversation —
    // must stay NULL.
    expect(getRequestLogById(b!)?.agentLoopExitReason).toBeNull();
  });

  test("no-op when conversation has no logs", () => {
    expect(() =>
      setAgentLoopExitReasonOnLatestLog("conv-missing", "error"),
    ).not.toThrow();
  });

  test("does not clobber a previous run's reason when the current run never landed a row", () => {
    // Previous run: completes, lands a log, gets stamped.
    const prev = recordRequestLog("conv-1", '{"prev_req":1}', '{"prev_res":1}');
    setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");
    expect(getRequestLogById(prev!)?.agentLoopExitReason).toBe("no_tool_calls");

    // Current run aborts pre-call (or similar) before any LLM call lands.
    // The helper must NOT overwrite the previous run's row.
    setAgentLoopExitReasonOnLatestLog("conv-1", "aborted_pre_call");
    expect(getRequestLogById(prev!)?.agentLoopExitReason).toBe("no_tool_calls");
  });

  test("stamps the current run's newest row even when a prior row is already stamped", () => {
    // Prior run already stamped.
    const prev = recordRequestLog("conv-1", '{"prev_req":1}', '{"prev_res":1}');
    setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");

    // Current run lands a new log, then exits.
    Bun.sleepSync(2);
    const current = recordRequestLog(
      "conv-1",
      '{"cur_req":1}',
      '{"cur_res":1}',
    );
    setAgentLoopExitReasonOnLatestLog("conv-1", "yield_to_user");

    expect(getRequestLogById(prev!)?.agentLoopExitReason).toBe("no_tool_calls");
    expect(getRequestLogById(current!)?.agentLoopExitReason).toBe(
      "yield_to_user",
    );
  });
});
