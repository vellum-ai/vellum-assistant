import { describe, expect, test } from "bun:test";

import {
  type ChatEntry,
  type PersistedMessage,
  type PersistedSession,
  hasPendingApproval,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  selectLatestHistorySession,
} from "@/components/app/settings/panels/doctorHistory.js";

const baseOccurredAt = "2026-04-15T12:00:00.000Z";

function msg(overrides: Partial<PersistedMessage>): PersistedMessage {
  return {
    id: "m-1",
    kind: "user",
    content: "",
    metadata: {},
    sequence: 1,
    occurred_at: baseOccurredAt,
    ...overrides,
  };
}

describe("mapPersistedMessagesToEntries", () => {
  test("empty input yields empty output", () => {
    expect(mapPersistedMessagesToEntries([])).toEqual([]);
  });

  test("USER row maps to user entry with parsed timestamp", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-user",
        kind: "user",
        content: "hello",
        occurred_at: baseOccurredAt,
      }),
    ]);
    expect(result).toEqual([
      {
        id: "m-user",
        kind: "user",
        content: "hello",
        timestamp: Date.parse(baseOccurredAt),
      },
    ]);
  });

  test("ASSISTANT row maps to assistant entry", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-asst",
        kind: "assistant",
        content: "the full assistant reply",
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m-asst",
      kind: "assistant",
      content: "the full assistant reply",
    });
  });

  test("ERROR row maps to error entry", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-err", kind: "error", content: "boom" }),
    ]);
    expect(result).toEqual([
      {
        id: "m-err",
        kind: "error",
        content: "boom",
        timestamp: Date.parse(baseOccurredAt),
      },
    ]);
  });

  test("TOOL_CALL row preserves tool metadata and defaults to running", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "search",
        metadata: { toolName: "search", input: { q: "hi" }, id: "call-1" },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m-tc",
      kind: "tool_call",
      content: "search",
      meta: {
        toolName: "search",
        input: { q: "hi" },
        id: "call-1",
        status: "running",
      },
    });
  });

  test("TOOL_CALL falls back to content if metadata.toolName missing", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "fallback_name",
        metadata: { input: {}, id: "call-x" },
      }),
    ]);
    expect(result[0]?.content).toBe("fallback_name");
    expect(result[0]?.meta?.toolName).toBe("fallback_name");
  });

  test("TOOL_RESULT merges into matching TOOL_CALL by metadata.toolCallId", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "search",
        metadata: { toolName: "search", input: { q: "hi" }, id: "call-1" },
      }),
      msg({
        id: "m-tr",
        kind: "tool_result",
        content: "the raw output",
        metadata: { toolCallId: "call-1", isError: false },
        sequence: 2,
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("tool_call");
    expect(result[0]?.meta).toMatchObject({
      result: "the raw output",
      isError: false,
      status: "completed",
      toolName: "search",
      input: { q: "hi" },
      id: "call-1",
    });
    // No standalone tool_result entry.
    expect(result.some((e) => e.kind === "tool_result")).toBe(false);
  });

  test("TOOL_RESULT with isError=true marks merged entry status=error", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "search",
        metadata: { toolName: "search", input: {}, id: "call-1" },
      }),
      msg({
        id: "m-tr",
        kind: "tool_result",
        content: "stack trace",
        metadata: { toolCallId: "call-1", isError: true },
        sequence: 2,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.meta).toMatchObject({
      result: "stack trace",
      isError: true,
      status: "error",
    });
  });

  test("TOOL_CALL without TOOL_RESULT keeps status=running", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "search",
        metadata: { toolName: "search", input: {}, id: "call-1" },
      }),
    ]);
    expect(result[0]?.meta?.status).toBe("running");
    expect(result[0]?.meta?.result).toBeUndefined();
  });

  test("orphan TOOL_RESULT (no matching TOOL_CALL) is dropped silently", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tr",
        kind: "tool_result",
        content: "lonely output",
        metadata: { toolCallId: "missing", isError: false },
      }),
    ]);
    expect(result).toEqual([]);
  });

  test("APPROVAL row preserves toolName, input, id, description in meta", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-app",
        kind: "approval",
        content: "delete_thing",
        metadata: {
          toolName: "delete_thing",
          input: { target: "x" },
          id: "appr-1",
          description: "Delete x permanently",
        },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m-app",
      kind: "approval",
      content: "delete_thing",
      meta: {
        toolName: "delete_thing",
        input: { target: "x" },
        id: "appr-1",
        description: "Delete x permanently",
      },
    });
  });

  test("STATUS=active is filtered out", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-st", kind: "status", content: "active" }),
    ]);
    expect(result).toEqual([]);
  });

  test("STATUS=completed emits 'Session completed'", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-st", kind: "status", content: "completed" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m-st",
      kind: "status",
      content: "Session completed",
    });
  });

  test("STATUS=error emits 'Session ended with error'", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-st", kind: "status", content: "error" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m-st",
      kind: "status",
      content: "Session ended with error",
    });
  });

  test("unexpected STATUS values are skipped defensively", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-st", kind: "status", content: "pending" }),
    ]);
    expect(result).toEqual([]);
  });

  test("timestamps are Date.parse(occurred_at)", () => {
    const occurred = "2026-01-02T03:04:05.000Z";
    const result = mapPersistedMessagesToEntries([
      msg({ id: "m-1", kind: "user", content: "hi", occurred_at: occurred }),
    ]);
    expect(result[0]?.timestamp).toBe(Date.parse(occurred));
  });

  test("preserves order of mixed input kinds", () => {
    const result = mapPersistedMessagesToEntries([
      msg({ id: "u", kind: "user", content: "hi", sequence: 1 }),
      msg({ id: "a", kind: "assistant", content: "hello", sequence: 2 }),
      msg({
        id: "tc",
        kind: "tool_call",
        content: "search",
        metadata: { toolName: "search", input: {}, id: "c1" },
        sequence: 3,
      }),
      msg({
        id: "tr",
        kind: "tool_result",
        content: "ok",
        metadata: { toolCallId: "c1", isError: false },
        sequence: 4,
      }),
      msg({
        id: "s",
        kind: "status",
        content: "completed",
        sequence: 5,
      }),
    ]);
    expect(result.map((e) => e.id)).toEqual(["u", "a", "tc", "s"]);
  });

  test("handles null/non-object metadata defensively", () => {
    const result = mapPersistedMessagesToEntries([
      msg({
        id: "m-tc",
        kind: "tool_call",
        content: "search",
        metadata: null,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.meta?.status).toBe("running");
  });
});

describe("mapPersistedStatusToPanelStatus", () => {
  test("ACTIVE -> active (panel resumes the live session on refresh; caller reconnects SSE)", () => {
    expect(mapPersistedStatusToPanelStatus("active")).toBe("active");
  });
  test("COMPLETED -> completed", () => {
    expect(mapPersistedStatusToPanelStatus("completed")).toBe("completed");
  });
  test("ERROR -> error", () => {
    expect(mapPersistedStatusToPanelStatus("error")).toBe("error");
  });
});

describe("hasPendingApproval", () => {
  function entry(overrides: Partial<ChatEntry>): ChatEntry {
    return {
      id: "e-1",
      kind: "assistant",
      content: "",
      timestamp: 0,
      ...overrides,
    };
  }

  test("empty timeline has no pending approval", () => {
    expect(hasPendingApproval([])).toBe(false);
  });

  test("last entry is approval -> pending", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "user", content: "hi" }),
        entry({ kind: "approval", content: "shell" }),
      ]),
    ).toBe(true);
  });

  test("approval followed only by status entries is still pending", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "approval", content: "shell" }),
        entry({ kind: "status", content: "Session completed" }),
      ]),
    ).toBe(true);
  });

  test("approval followed by user reply is NOT pending", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "approval", content: "shell" }),
        entry({ kind: "user", content: "approve" }),
      ]),
    ).toBe(false);
  });

  test("approval followed by assistant turn is NOT pending", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "approval", content: "shell" }),
        entry({ kind: "assistant", content: "done" }),
      ]),
    ).toBe(false);
  });

  test("approval followed by tool_call is NOT pending", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "approval", content: "shell" }),
        entry({ kind: "tool_call", content: "search" }),
      ]),
    ).toBe(false);
  });

  test("no approvals anywhere -> false", () => {
    expect(
      hasPendingApproval([
        entry({ kind: "user", content: "hi" }),
        entry({ kind: "assistant", content: "hello" }),
      ]),
    ).toBe(false);
  });
});

describe("selectLatestHistorySession", () => {
  test("returns null for empty list", () => {
    expect(selectLatestHistorySession([])).toBeNull();
  });

  test("returns first item, trusting backend ordering", () => {
    const s1: PersistedSession = {
      id: "1",
      status: "active",
      last_message_at: "2026-04-15T12:00:00Z",
      ended_at: null,
      created: "2026-04-15T11:00:00Z",
      modified: "2026-04-15T12:00:00Z",
    };
    const s2: PersistedSession = {
      id: "2",
      status: "completed",
      last_message_at: "2026-04-14T12:00:00Z",
      ended_at: "2026-04-14T13:00:00Z",
      created: "2026-04-14T11:00:00Z",
      modified: "2026-04-14T13:00:00Z",
    };
    const s3: PersistedSession = {
      id: "3",
      status: "completed",
      last_message_at: null,
      ended_at: "2026-04-13T13:00:00Z",
      created: "2026-04-13T11:00:00Z",
      modified: "2026-04-13T13:00:00Z",
    };
    expect(selectLatestHistorySession([s1, s2, s3])).toBe(s1);
  });
});
