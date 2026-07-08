import { describe, expect, test } from "bun:test";

import type { DoctorMessage } from "@/generated/api/types.gen";

import {
  hasPendingApproval,
  hasPendingBackup,
  isReplayableDoctorSourceEventId,
  latestReplayableDoctorSourceEventId,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  replayableDoctorSourceEventIds,
  selectLatestHistorySession,
  serializeSessionToText,
} from "@/domains/settings/components/panels/doctor-history";
import type { ChatEntry } from "@/domains/settings/components/panels/doctor-history";

function msg(overrides: Partial<DoctorMessage> & Pick<DoctorMessage, "kind">): DoctorMessage {
  return {
    id: "msg-1",
    content: "",
    metadata: null,
    sequence: 0,
    source_event_id: null,
    occurred_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mapPersistedMessagesToEntries
// ---------------------------------------------------------------------------

describe("mapPersistedMessagesToEntries", () => {
  test("maps user message", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "user", content: "Hello" }),
    ]);
    expect(entries).toEqual([
      {
        id: "msg-1",
        kind: "user",
        content: "Hello",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  test("maps assistant message", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "assistant", content: "Hi there" }),
    ]);
    expect(entries).toEqual([
      {
        id: "msg-1",
        kind: "assistant",
        content: "Hi there",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  test("maps tool_call with metadata", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({
        kind: "tool_call",
        content: "run_diagnostics",
        metadata: { toolName: "run_diagnostics", input: { flag: true }, id: "tc-1" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("tool_call");
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("run_diagnostics");
    expect(entry.meta.input).toEqual({ flag: true });
    expect(entry.meta.toolCallId).toBe("tc-1");
    expect(entry.meta.status).toBe("running");
  });

  test("tool_call falls back to content when metadata lacks toolName", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "tool_call", content: "fallback_name", metadata: {} }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("fallback_name");
    expect(entry.content).toBe("fallback_name");
  });

  test("tool_call falls back to message.id when metadata.id is missing", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ id: "msg-tc", kind: "tool_call", content: "tool", metadata: { toolName: "tool" } }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolCallId).toBe("msg-tc");
  });

  test("tool_result pairs with preceding tool_call", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({
        id: "msg-tc",
        kind: "tool_call",
        content: "diag",
        metadata: { toolName: "diag", input: {}, id: "tc-1" },
      }),
      msg({
        id: "msg-tr",
        kind: "tool_result",
        content: "result data",
        metadata: { toolCallId: "tc-1", isError: false },
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.result).toBe("result data");
    expect(entry.meta.isError).toBe(false);
    expect(entry.meta.status).toBe("completed");
  });

  test("tool_result with isError marks status as error", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({
        id: "msg-tc",
        kind: "tool_call",
        content: "diag",
        metadata: { toolName: "diag", input: {}, id: "tc-1" },
      }),
      msg({
        id: "msg-tr",
        kind: "tool_result",
        content: "something went wrong",
        metadata: { toolCallId: "tc-1", isError: true },
      }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.isError).toBe(true);
    expect(entry.meta.status).toBe("error");
  });

  test("tool_result with no matching tool_call is silently skipped", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({
        kind: "tool_result",
        content: "orphan",
        metadata: { toolCallId: "nonexistent" },
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  test("maps approval with metadata", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({
        kind: "approval",
        content: "exec",
        metadata: {
          toolName: "exec_command",
          input: { cmd: "ls" },
          id: "ap-1",
          description: "Run ls in /tmp",
        },
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    if (entry.kind !== "approval") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("exec_command");
    expect(entry.meta.toolCallId).toBe("ap-1");
    expect(entry.meta.description).toBe("Run ls in /tmp");
  });

  test("approval falls back to empty description when metadata lacks it", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "approval", content: "exec", metadata: { toolName: "exec" } }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "approval") {
      throw new Error("unreachable");
    }
    expect(entry.meta.description).toBe("");
  });

  test("maps status 'completed'", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "status", content: "completed" }),
    ]);
    expect(entries).toEqual([
      {
        id: "msg-1",
        kind: "status",
        content: "Session completed",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  test("maps status 'error'", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "status", content: "error" }),
    ]);
    expect(entries[0]!.content).toBe("Session ended with error");
  });

  test("skips unknown status content", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "status", content: "active" }),
    ]);
    expect(entries).toHaveLength(0);
  });

  test("maps error message", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "error", content: "Something failed" }),
    ]);
    expect(entries).toEqual([
      {
        id: "msg-1",
        kind: "error",
        content: "Something failed",
        timestamp: Date.parse("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  test("handles non-object metadata gracefully", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "tool_call", content: "tool", metadata: "not an object" }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("tool");
    expect(entry.meta.input).toEqual({});
  });

  test("handles null metadata gracefully", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "tool_call", content: "tool", metadata: null }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("tool");
  });

  test("handles array metadata gracefully", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ kind: "tool_call", content: "tool", metadata: [1, 2, 3] }),
    ]);
    const entry = entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("tool");
    expect(entry.meta.input).toEqual({});
  });

  test("processes mixed message sequence", () => {
    const entries = mapPersistedMessagesToEntries([
      msg({ id: "1", kind: "user", content: "help" }),
      msg({ id: "2", kind: "assistant", content: "analyzing..." }),
      msg({
        id: "3",
        kind: "tool_call",
        content: "diag",
        metadata: { toolName: "diag", input: {}, id: "tc-1" },
      }),
      msg({
        id: "4",
        kind: "tool_result",
        content: "ok",
        metadata: { toolCallId: "tc-1", isError: false },
      }),
      msg({ id: "5", kind: "status", content: "completed" }),
    ]);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "status"]);
    const toolEntry = entries[2]!;
    if (toolEntry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(toolEntry.meta.status).toBe("completed");
  });

  test("returns empty array for empty input", () => {
    expect(mapPersistedMessagesToEntries([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapPersistedStatusToPanelStatus
// ---------------------------------------------------------------------------

describe("mapPersistedStatusToPanelStatus", () => {
  test("maps active", () => {
    expect(mapPersistedStatusToPanelStatus("active")).toBe("active");
  });
  test("maps completed", () => {
    expect(mapPersistedStatusToPanelStatus("completed")).toBe("completed");
  });
  test("maps error", () => {
    expect(mapPersistedStatusToPanelStatus("error")).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// replayable Doctor source event IDs
// ---------------------------------------------------------------------------

describe("Doctor source event ID helpers", () => {
  test("accepts Redis stream IDs and rejects legacy or malformed values", () => {
    expect(isReplayableDoctorSourceEventId("123-0")).toBe(true);
    expect(isReplayableDoctorSourceEventId("123")).toBe(false);
    expect(isReplayableDoctorSourceEventId("evt-123")).toBe(false);
    expect(isReplayableDoctorSourceEventId(null)).toBe(false);
    expect(isReplayableDoctorSourceEventId(undefined)).toBe(false);
  });

  test("extracts replayable IDs in persisted message order", () => {
    const messages = [
      { source_event_id: null },
      { source_event_id: "1-0" },
      { source_event_id: "legacy-event" },
      { source_event_id: "2-0" },
    ];

    expect(replayableDoctorSourceEventIds(messages)).toEqual(["1-0", "2-0"]);
  });

  test("returns the latest replayable ID from persisted history", () => {
    const messages = [
      { source_event_id: "1-0" },
      { source_event_id: null },
      { source_event_id: "2-0" },
      { source_event_id: "legacy-event" },
    ];

    expect(latestReplayableDoctorSourceEventId(messages)).toBe("2-0");
  });

  test("returns null when persisted history has no replayable IDs", () => {
    expect(
      latestReplayableDoctorSourceEventId([
        { source_event_id: null },
        { source_event_id: "legacy-event" },
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasPendingApproval
// ---------------------------------------------------------------------------

describe("hasPendingApproval", () => {
  test("returns true when last non-status entry is approval", () => {
    const entries: ChatEntry[] = [
      { id: "1", kind: "user", content: "x", timestamp: 0 },
      {
        id: "2",
        kind: "approval",
        content: "exec",
        timestamp: 0,
        meta: { toolName: "exec", input: {}, toolCallId: "tc-1", description: "" },
      },
      { id: "3", kind: "status", content: "active", timestamp: 0 },
    ];
    expect(hasPendingApproval(entries)).toBe(true);
  });

  test("returns false when last non-status entry is not approval", () => {
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "approval",
        content: "exec",
        timestamp: 0,
        meta: { toolName: "exec", input: {}, toolCallId: "tc-1", description: "" },
      },
      { id: "2", kind: "assistant", content: "done", timestamp: 0 },
    ];
    expect(hasPendingApproval(entries)).toBe(false);
  });

  test("returns false for empty entries", () => {
    expect(hasPendingApproval([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasPendingBackup
// ---------------------------------------------------------------------------

describe("hasPendingBackup", () => {
  test("returns true when last non-status entry is backup_prompt", () => {
    const entries: ChatEntry[] = [
      { id: "1", kind: "user", content: "x", timestamp: 0 },
      {
        id: "2",
        kind: "backup_prompt",
        content: "tool",
        timestamp: 0,
        meta: { toolName: "tool" },
      },
    ];
    expect(hasPendingBackup(entries)).toBe(true);
  });

  test("returns false when last non-status entry is not backup_prompt", () => {
    const entries: ChatEntry[] = [
      { id: "1", kind: "assistant", content: "ok", timestamp: 0 },
    ];
    expect(hasPendingBackup(entries)).toBe(false);
  });

  test("returns false for empty entries", () => {
    expect(hasPendingBackup([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeSessionToText
// ---------------------------------------------------------------------------

describe("serializeSessionToText", () => {
  test("returns empty string for empty entries", () => {
    // GIVEN an empty entries array
    const entries: ChatEntry[] = [];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN the result is empty
    expect(result).toBe("");
  });

  test("serializes user and assistant messages with role prefixes", () => {
    // GIVEN user and assistant entries
    const entries: ChatEntry[] = [
      { id: "1", kind: "user", content: "help me", timestamp: 0 },
      { id: "2", kind: "assistant", content: "sure thing", timestamp: 0 },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN each entry has the correct prefix, separated by double newlines
    expect(result).toBe("User: help me\n\nDoctor: sure thing");
  });

  test("serializes tool_call with input and output", () => {
    // GIVEN a tool_call entry with input and result
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "tool_call",
        content: "search",
        timestamp: 0,
        meta: {
          toolName: "search",
          input: { q: "hello" },
          toolCallId: "tc-1",
          status: "completed",
          result: "found it",
          isError: false,
        },
      },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN it includes tool name, input, and output
    expect(result).toContain("Tool Call: search");
    expect(result).toContain("Input:");
    expect(result).toContain('"q": "hello"');
    expect(result).toContain("Output: found it");
  });

  test("serializes tool_call error result with Error label", () => {
    // GIVEN a tool_call entry with an error result
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "tool_call",
        content: "rm",
        timestamp: 0,
        meta: {
          toolName: "rm",
          input: {},
          toolCallId: "tc-1",
          status: "error",
          result: "permission denied",
          isError: true,
        },
      },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN the result is labeled as Error
    expect(result).toContain("Error: permission denied");
  });

  test("serializes approval with description and input", () => {
    // GIVEN an approval entry with description and input
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "approval",
        content: "delete_thing",
        timestamp: 0,
        meta: {
          toolName: "delete_thing",
          input: { target: "workspace" },
          toolCallId: "ap-1",
          description: "Delete x permanently",
        },
      },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN it includes tool name, description, and input
    expect(result).toContain("Approval Required: delete_thing — Delete x permanently");
    expect(result).toContain("Input:");
    expect(result).toContain('"target": "workspace"');
  });

  test("serializes error entry with Error prefix", () => {
    // GIVEN an error entry
    const entries: ChatEntry[] = [
      { id: "1", kind: "error", content: "connection lost", timestamp: 0 },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN it has the Error prefix
    expect(result).toBe("Error: connection lost");
  });

  test("serializes status entry with separator formatting", () => {
    // GIVEN a status entry
    const entries: ChatEntry[] = [
      { id: "1", kind: "status", content: "Session completed", timestamp: 0 },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN it uses separator formatting
    expect(result).toBe("--- Session completed ---");
  });

  test("serializes backup_prompt with tool name", () => {
    // GIVEN a backup_prompt entry
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "backup_prompt",
        content: "modify_config",
        timestamp: 0,
        meta: { toolName: "modify_config" },
      },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN it includes the tool name
    expect(result).toBe("Backup Prompt: modify_config");
  });

  test("serializes a full session in order with double newline separators", () => {
    // GIVEN a mixed session timeline
    const entries: ChatEntry[] = [
      { id: "1", kind: "user", content: "fix my assistant", timestamp: 0 },
      { id: "2", kind: "assistant", content: "Looking into it...", timestamp: 0 },
      {
        id: "3",
        kind: "tool_call",
        content: "inspect",
        timestamp: 0,
        meta: { toolName: "inspect", input: {}, toolCallId: "tc-1", status: "completed" },
      },
      { id: "4", kind: "assistant", content: "Found the issue.", timestamp: 0 },
      { id: "5", kind: "status", content: "Session completed", timestamp: 0 },
    ];

    // WHEN we serialize
    const result = serializeSessionToText(entries);

    // THEN all entries are present in order separated by double newlines
    const parts = result.split("\n\n");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("User: fix my assistant");
    expect(parts[4]).toBe("--- Session completed ---");
  });
});

// ---------------------------------------------------------------------------
// selectLatestHistorySession
// ---------------------------------------------------------------------------

describe("selectLatestHistorySession", () => {
  test("returns first session from list", () => {
    const sessions = [
      { last_message_at: "2026-01-02", created: "2026-01-01" },
      { last_message_at: "2026-01-01", created: "2025-12-31" },
    ];
    expect(selectLatestHistorySession(sessions)).toBe(sessions[0]);
  });

  test("returns null for empty list", () => {
    expect(selectLatestHistorySession([])).toBeNull();
  });
});
