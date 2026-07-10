/**
 * When ClickHouse owns LLM-request-log writes, the store's SQLite row mutators
 * must skip — otherwise they mutate stale local rows left over from earlier
 * local-mode turns (e.g. `setAgentLoopExitReasonOnLatestLog` would stamp this
 * turn's reason onto an unrelated prior call). These tests seed a local row in
 * local mode, flip `readSource` to `clickhouse`, and assert each mutator leaves
 * the local row untouched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mutable read source drives both the write routing and the mutator guards.
let readSource: "local" | "clickhouse" = "local";
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llmRequestLogs: { readSource } }),
  getConfigReadOnly: () => ({ llmRequestLogs: { readSource } }),
}));

afterAll(() => {
  readSource = "local";
});

import { getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  backfillMessageIdOnLogs,
  getRequestLogById,
  recordRequestLog,
  relinkLlmRequestLogs,
  setAgentLoopExitReasonOnLatestLog,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs } from "../persistence/schema/index.js";

await initializeDb();

function resetLogs(): void {
  getLogsDb()!.delete(llmRequestLogs).run();
}

/** Seed one local SQLite row in local-write mode and return its id. */
function seedLocalRow(
  conversationId: string,
  opts: { messageId?: string } = {},
): string {
  readSource = "local";
  const id = recordRequestLog(
    conversationId,
    '{"req":1}',
    '{"res":1}',
    opts.messageId,
    "anthropic",
    "mainAgent",
  );
  expect(id).not.toBeNull();
  return id!;
}

describe("SQLite mutators skip when ClickHouse owns writes", () => {
  beforeEach(() => {
    resetLogs();
    readSource = "local";
  });

  test("setAgentLoopExitReasonOnLatestLog stamps in local mode", () => {
    const id = seedLocalRow("conv-1");
    setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");
    expect(getRequestLogById(id)?.agentLoopExitReason).toBe("no_tool_calls");
  });

  test("setAgentLoopExitReasonOnLatestLog leaves stale local rows untouched in ClickHouse mode", () => {
    // An older local-mode row with a NULL exit reason (a normal intermediate
    // call). A later ClickHouse-mode turn must NOT stamp it.
    const staleId = seedLocalRow("conv-1");
    readSource = "clickhouse";
    setAgentLoopExitReasonOnLatestLog("conv-1", "yield_to_user");
    expect(getRequestLogById(staleId)?.agentLoopExitReason).toBeNull();
  });

  test("backfillMessageIdOnLogs leaves stale local rows untouched in ClickHouse mode", () => {
    const staleId = seedLocalRow("conv-2"); // messageId NULL
    expect(getRequestLogById(staleId)?.messageId).toBeNull();
    readSource = "clickhouse";
    backfillMessageIdOnLogs("conv-2", "msg-new");
    expect(getRequestLogById(staleId)?.messageId).toBeNull();
  });

  test("relinkLlmRequestLogs leaves stale local rows untouched in ClickHouse mode", () => {
    const staleId = seedLocalRow("conv-3", { messageId: "m1" });
    expect(getRequestLogById(staleId)?.messageId).toBe("m1");
    readSource = "clickhouse";
    relinkLlmRequestLogs(["m1"], "m2");
    expect(getRequestLogById(staleId)?.messageId).toBe("m1");
  });

  test("backfillMessageIdOnLogs still works in local mode", () => {
    const id = seedLocalRow("conv-4");
    backfillMessageIdOnLogs("conv-4", "msg-local");
    expect(getRequestLogById(id)?.messageId).toBe("msg-local");
  });
});
