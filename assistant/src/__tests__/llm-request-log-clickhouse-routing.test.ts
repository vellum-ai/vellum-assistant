/**
 * Tests that the store's write path routes to ClickHouse instead of local
 * SQLite when a ClickHouse sink is configured — and stays on SQLite
 * otherwise. The sink module is mocked so the routing decision is observable
 * without a live ClickHouse.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Logging stays enabled; `getConfigReadOnly` is only consulted by the store.s
// disabled gate here (the sink factory itself is mocked below).
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llmRequestLogs: { readSource: "local" } }),
  getConfigReadOnly: () => ({ llmRequestLogs: { readSource: "local" } }),
}));

// Mutable fake sink: when non-null, the store must route to it.
interface CapturedRow {
  id: string;
  conversationId: string;
  callSite: string | null;
}
let capturedRows: CapturedRow[] = [];
let sinkActive = false;
mock.module("../persistence/llm-request-log-sink-clickhouse.js", () => ({
  getClickHouseLlmRequestLogSink: () =>
    sinkActive
      ? {
          recordBestEffort: (row: CapturedRow) => {
            capturedRows.push(row);
          },
        }
      : null,
}));

afterAll(() => {
  sinkActive = false;
});

import { getLogsDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getRequestLogsByConversationId,
  recordRequestLog,
  recordSyntheticAgentErrorMessageLog,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs } from "../persistence/schema/index.js";

await initializeDb();

function resetLogs(): void {
  getLogsDb()!.delete(llmRequestLogs).run();
}

describe("write routing between SQLite and ClickHouse", () => {
  beforeEach(() => {
    resetLogs();
    capturedRows = [];
    sinkActive = false;
  });

  test("writes to local SQLite when no ClickHouse sink is configured", () => {
    const id = recordRequestLog(
      "conv-local",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    expect(id).not.toBeNull();
    expect(capturedRows).toHaveLength(0);
    const rows = getRequestLogsByConversationId("conv-local");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("anthropic");
  });

  test("routes to ClickHouse and skips SQLite when a sink is configured", () => {
    sinkActive = true;
    const id = recordRequestLog(
      "conv-ch",
      '{"req":1}',
      '{"res":1}',
      "msg-ch",
      "openai",
      "mainAgent",
    );
    expect(id).not.toBeNull();
    // Nothing landed in the local table.
    expect(getRequestLogsByConversationId("conv-ch")).toEqual([]);
    // The row went to the sink, carrying the same id and call site.
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0]!.id).toBe(id!);
    expect(capturedRows[0]!.conversationId).toBe("conv-ch");
    expect(capturedRows[0]!.callSite).toBe("mainAgent");
  });

  test("routes synthetic error rows to ClickHouse too", () => {
    sinkActive = true;
    const id = recordSyntheticAgentErrorMessageLog({
      conversationId: "conv-ch-2",
      messageId: "msg-ch-2",
      exitReason: "budget_yield_unrecovered",
      noticeText: "Out of budget.",
      preparedRequest: null,
      createdAt: 1_700_000_000_000,
    });
    expect(id).not.toBeNull();
    expect(getRequestLogsByConversationId("conv-ch-2")).toEqual([]);
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0]!.callSite).toBe("syntheticAgentErrorMessage");
  });
});
