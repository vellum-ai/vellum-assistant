import { beforeEach, describe, expect, test } from "bun:test";

import type { ChatEntry } from "@/domains/settings/components/panels/doctor-history";
import {
  handleApprovalRequired,
  handleBackupPrompt,
  handleError,
  handleFeedbackPrompt,
  handleMessageComplete,
  handleMessageDelta,
  handleStatus,
  handleToolCall,
  handleToolResult,
} from "@/domains/settings/components/panels/doctor-event-handlers";
import { parseDoctorEvent } from "@/domains/settings/components/panels/doctor-event-schema";
import {
  type DoctorPanelContext,
  useDoctorPanelStore,
} from "@/domains/settings/components/panels/doctor-panel-store";
import { shouldResetDoctorSseReconnectBudget } from "@/domains/settings/components/panels/doctor-sse-reconnect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

beforeEach(() => {
  useDoctorPanelStore.getState().resetReplayState();
});

function createMockContext(initialEntries: ChatEntry[] = []): DoctorPanelContext & {
  entries: ChatEntry[];
  calls: Record<string, unknown[]>;
} {
  let entries = [...initialEntries];
  let streamingEntryId: string | null = null;
  const calls: Record<string, unknown[]> = {
    setThinking: [],
    setPendingApproval: [],
    setPendingBackup: [],
    setSessionStatus: [],
    appendEntry: [],
  };

  return {
    get entries() {
      return entries;
    },
    getEntries: () => entries,
    calls,
    updateEntries: (updater) => {
      entries = updater(entries);
    },
    setThinking: (v) => calls.setThinking.push(v),
    setPendingApproval: (v) => calls.setPendingApproval.push(v),
    setPendingBackup: (v) => calls.setPendingBackup.push(v),
    setSessionStatus: (s) => calls.setSessionStatus.push(s),
    appendEntry: (entry) => {
      const id = `entry-${++idCounter}`;
      entries = [...entries, { ...entry, id, timestamp: Date.now() } as ChatEntry];
      calls.appendEntry.push(entry);
    },
    nextId: () => `entry-${++idCounter}`,
    getStreamingEntryId: () => streamingEntryId,
    setStreamingEntryId: (id) => { streamingEntryId = id; },
  };
}

// ---------------------------------------------------------------------------
// parseDoctorEvent
// ---------------------------------------------------------------------------

describe("parseDoctorEvent", () => {
  test("parses message_delta event", () => {
    const event = parseDoctorEvent(JSON.stringify({ type: "message_delta", content: "hi" }));
    expect(event).toEqual({ type: "message_delta", content: "hi" });
  });

  test("preserves optional source_event_id on replayable events", () => {
    const event = parseDoctorEvent(
      JSON.stringify({
        type: "message_delta",
        content: "hi",
        source_event_id: "123-0",
      }),
    );

    expect(event).toEqual({
      type: "message_delta",
      content: "hi",
      source_event_id: "123-0",
    });
  });

  test("allows legacy events without source_event_id", () => {
    const event = parseDoctorEvent(
      JSON.stringify({ type: "status", status: "active" }),
    );

    expect(event).toEqual({ type: "status", status: "active" });
  });

  test("parses message event", () => {
    const event = parseDoctorEvent(JSON.stringify({ type: "message", content: "done" }));
    expect(event).toEqual({ type: "message", content: "done" });
  });

  test("parses tool_call event", () => {
    const event = parseDoctorEvent(
      JSON.stringify({ type: "tool_call", toolName: "diag", input: { a: 1 }, id: "tc-1" }),
    );
    expect(event).toEqual({ type: "tool_call", toolName: "diag", input: { a: 1 }, id: "tc-1" });
  });

  test("parses tool_result event", () => {
    const event = parseDoctorEvent(
      JSON.stringify({ type: "tool_result", toolCallId: "tc-1", content: "ok", isError: false }),
    );
    expect(event).toEqual({ type: "tool_result", toolCallId: "tc-1", content: "ok", isError: false });
  });

  test("parses approval_required event", () => {
    const event = parseDoctorEvent(
      JSON.stringify({
        type: "approval_required",
        toolName: "exec",
        input: {},
        id: "ap-1",
        description: "Run command",
      }),
    );
    expect(event).toEqual({
      type: "approval_required",
      toolName: "exec",
      input: {},
      id: "ap-1",
      description: "Run command",
    });
  });

  test("parses backup_prompt event", () => {
    const event = parseDoctorEvent(JSON.stringify({ type: "backup_prompt", toolName: "tool" }));
    expect(event).toEqual({ type: "backup_prompt", toolName: "tool" });
  });

  test("parses feedback_prompt event", () => {
    const event = parseDoctorEvent(
      JSON.stringify({
        type: "feedback_prompt",
        summary: "The app colors are ugly.",
        classification: "other",
        source_event_id: "123-0",
      }),
    );
    expect(event).toEqual({
      type: "feedback_prompt",
      summary: "The app colors are ugly.",
      classification: "other",
      source_event_id: "123-0",
    });
  });

  test("parses status event", () => {
    const event = parseDoctorEvent(JSON.stringify({ type: "status", status: "completed" }));
    expect(event).toEqual({ type: "status", status: "completed" });
  });

  test("parses error event", () => {
    const event = parseDoctorEvent(JSON.stringify({ type: "error", message: "fail" }));
    expect(event).toEqual({ type: "error", message: "fail" });
  });

  test("returns null for invalid JSON", () => {
    expect(parseDoctorEvent("not json")).toBeNull();
  });

  test("returns null for non-object JSON", () => {
    expect(parseDoctorEvent('"just a string"')).toBeNull();
    expect(parseDoctorEvent("42")).toBeNull();
    expect(parseDoctorEvent("null")).toBeNull();
  });

  test("returns null for missing type field", () => {
    expect(parseDoctorEvent(JSON.stringify({ content: "hi" }))).toBeNull();
  });

  test("returns null for unknown type", () => {
    expect(parseDoctorEvent(JSON.stringify({ type: "unknown_event" }))).toBeNull();
  });

  test("returns null for numeric type", () => {
    expect(parseDoctorEvent(JSON.stringify({ type: 123 }))).toBeNull();
  });

  test("rejects tool_call missing required fields", () => {
    expect(parseDoctorEvent(JSON.stringify({ type: "tool_call", toolName: "diag" }))).toBeNull();
  });

  test("rejects tool_result with wrong isError type", () => {
    expect(
      parseDoctorEvent(
        JSON.stringify({ type: "tool_result", toolCallId: "tc-1", content: "ok", isError: "no" }),
      ),
    ).toBeNull();
  });

  test("rejects status with invalid status value", () => {
    expect(parseDoctorEvent(JSON.stringify({ type: "status", status: "paused" }))).toBeNull();
  });

  test("rejects approval_required missing description", () => {
    expect(
      parseDoctorEvent(
        JSON.stringify({ type: "approval_required", toolName: "exec", input: {}, id: "ap-1" }),
      ),
    ).toBeNull();
  });

  test("strips unknown extra fields from parsed events", () => {
    const event = parseDoctorEvent(
      JSON.stringify({ type: "message_delta", content: "hi", extra: "ignored" }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("message_delta");
    if (event!.type !== "message_delta") {
      throw new Error("unreachable");
    }
    expect(event!.content).toBe("hi");
    expect("extra" in event!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Doctor replay state
// ---------------------------------------------------------------------------

describe("Doctor replay state", () => {
  test("seeds latest cursor and processed IDs from persisted history", () => {
    const store = useDoctorPanelStore.getState();

    store.seedReplayState(["1-0", "2-0"], "2-0");

    const state = useDoctorPanelStore.getState();
    expect(state.latestReplayableSourceEventId).toBe("2-0");
    expect([...state.processedSourceEventIds]).toEqual(["1-0", "2-0"]);
  });

  test("drops duplicate replay IDs before they can be applied twice", () => {
    const store = useDoctorPanelStore.getState();

    store.seedReplayState(["1-0"], "1-0");

    expect(store.recordReplayableSourceEventId("1-0")).toBe(false);
    expect(store.recordReplayableSourceEventId("2-0")).toBe(true);
    expect(store.recordReplayableSourceEventId("2-0")).toBe(false);
    expect(useDoctorPanelStore.getState().latestReplayableSourceEventId).toBe(
      "2-0",
    );
  });
});

// ---------------------------------------------------------------------------
// Doctor SSE reconnect budget
// ---------------------------------------------------------------------------

describe("Doctor SSE reconnect budget", () => {
  test("keeps retry budget for heartbeat-only attempts", () => {
    expect(shouldResetDoctorSseReconnectBudget(false)).toBe(false);
  });

  test("resets retry budget after data frames", () => {
    expect(shouldResetDoctorSseReconnectBudget(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleMessageDelta
// ---------------------------------------------------------------------------

describe("handleMessageDelta", () => {
  test("creates new streaming entry when no current streaming entry exists", () => {
    const ctx = createMockContext();
    handleMessageDelta(ctx, { content: "Hello" });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.kind).toBe("assistant");
    expect(ctx.entries[0]!.content).toBe("Hello");
    expect(ctx.calls.setThinking).toEqual([false]);
  });

  test("appends to existing streaming entry", () => {
    const ctx = createMockContext([
      { id: "e-1", kind: "assistant", content: "Hel", timestamp: 0 },
    ]);
    // Simulate that e-1 is the streaming entry
    ctx.setStreamingEntryId("e-1");

    handleMessageDelta(ctx, { content: "lo" });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.content).toBe("Hello");
  });

  test("does not modify unrelated entries when appending", () => {
    const ctx = createMockContext([
      { id: "user-1", kind: "user", content: "question", timestamp: 0 },
      { id: "e-1", kind: "assistant", content: "ans", timestamp: 0 },
    ]);
    ctx.setStreamingEntryId("e-1");

    handleMessageDelta(ctx, { content: "wer" });

    expect(ctx.entries[0]!.content).toBe("question");
    expect(ctx.entries[1]!.content).toBe("answer");
  });
});

// ---------------------------------------------------------------------------
// handleMessageComplete
// ---------------------------------------------------------------------------

describe("handleMessageComplete", () => {
  test("clears thinking and streaming entry id", () => {
    const ctx = createMockContext();
    ctx.setStreamingEntryId("e-1");

    handleMessageComplete(ctx);

    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.getStreamingEntryId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleToolCall
// ---------------------------------------------------------------------------

describe("handleToolCall", () => {
  test("appends tool_call entry with correct meta", () => {
    const ctx = createMockContext();

    handleToolCall(ctx, { toolName: "run_diag", input: { flag: true }, id: "tc-1" });

    expect(ctx.entries).toHaveLength(1);
    const entry = ctx.entries[0]!;
    expect(entry.kind).toBe("tool_call");
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("run_diag");
    expect(entry.meta.input).toEqual({ flag: true });
    expect(entry.meta.toolCallId).toBe("tc-1");
    expect(entry.meta.status).toBe("running");
    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.getStreamingEntryId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleToolResult
// ---------------------------------------------------------------------------

describe("handleToolResult", () => {
  test("updates matching tool_call entry with result", () => {
    const ctx = createMockContext([
      {
        id: "e-1",
        kind: "tool_call",
        content: "diag",
        timestamp: 0,
        meta: { toolName: "diag", input: {}, toolCallId: "tc-1", status: "running" as const },
      },
    ]);

    handleToolResult(ctx, { toolCallId: "tc-1", content: "all good", isError: false });

    expect(ctx.entries).toHaveLength(1);
    const entry = ctx.entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.result).toBe("all good");
    expect(entry.meta.isError).toBe(false);
    expect(entry.meta.status).toBe("completed");
  });

  test("marks status as error when isError is true", () => {
    const ctx = createMockContext([
      {
        id: "e-1",
        kind: "tool_call",
        content: "diag",
        timestamp: 0,
        meta: { toolName: "diag", input: {}, toolCallId: "tc-1", status: "running" as const },
      },
    ]);

    handleToolResult(ctx, { toolCallId: "tc-1", content: "failed", isError: true });

    const entry = ctx.entries[0]!;
    if (entry.kind !== "tool_call") {
      throw new Error("unreachable");
    }
    expect(entry.meta.status).toBe("error");
    expect(entry.meta.isError).toBe(true);
  });

  test("does nothing when no matching tool_call exists", () => {
    const ctx = createMockContext([
      { id: "e-1", kind: "assistant", content: "hello", timestamp: 0 },
    ]);

    handleToolResult(ctx, { toolCallId: "nonexistent", content: "result", isError: false });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.kind).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// handleApprovalRequired
// ---------------------------------------------------------------------------

describe("handleApprovalRequired", () => {
  test("appends approval entry and sets pending state", () => {
    const ctx = createMockContext();

    handleApprovalRequired(ctx, {
      toolName: "exec_cmd",
      input: { cmd: "ls" },
      id: "ap-1",
      description: "Run ls",
    });

    expect(ctx.entries).toHaveLength(1);
    const entry = ctx.entries[0]!;
    expect(entry.kind).toBe("approval");
    if (entry.kind !== "approval") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("exec_cmd");
    expect(entry.meta.toolCallId).toBe("ap-1");
    expect(entry.meta.description).toBe("Run ls");
    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.calls.setPendingApproval).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// handleBackupPrompt
// ---------------------------------------------------------------------------

describe("handleBackupPrompt", () => {
  test("appends backup_prompt entry and sets pending state", () => {
    const ctx = createMockContext();

    handleBackupPrompt(ctx, { toolName: "dangerous_tool" });

    expect(ctx.entries).toHaveLength(1);
    const entry = ctx.entries[0]!;
    expect(entry.kind).toBe("backup_prompt");
    if (entry.kind !== "backup_prompt") {
      throw new Error("unreachable");
    }
    expect(entry.meta.toolName).toBe("dangerous_tool");
    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.calls.setPendingBackup).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// handleFeedbackPrompt
// ---------------------------------------------------------------------------

describe("handleFeedbackPrompt", () => {
  test("appends feedback_prompt entry", () => {
    const ctx = createMockContext();

    handleFeedbackPrompt(ctx, { summary: "The app colors are ugly." });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.kind).toBe("feedback_prompt");
    expect(ctx.entries[0]!.content).toBe("The app colors are ugly.");
  });

  test("updates the current turn prompt instead of appending a duplicate", () => {
    const ctx = createMockContext([
      { id: "user-1", kind: "user", content: "I have feedback", timestamp: 0 },
      {
        id: "feedback-1",
        kind: "feedback_prompt",
        content: "Share feedback",
        timestamp: 0,
      },
    ]);

    handleFeedbackPrompt(ctx, { summary: "The color theme is ugly." });

    expect(ctx.entries).toHaveLength(2);
    expect(ctx.entries[1]!.content).toBe("The color theme is ugly.");
    expect(ctx.calls.appendEntry).toEqual([]);
  });

  test("stores feedback prompt reason from the event", () => {
    const ctx = createMockContext();

    handleFeedbackPrompt(ctx, {
      summary: "Compact mode would help.",
      classification: "feature_request",
    });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]).toMatchObject({
      kind: "feedback_prompt",
      content: "Compact mode would help.",
      meta: { reason: "feature_request" },
    });
  });

  test("appends another feedback prompt after a later user message", () => {
    const ctx = createMockContext([
      { id: "user-1", kind: "user", content: "I have feedback", timestamp: 0 },
      {
        id: "feedback-1",
        kind: "feedback_prompt",
        content: "Share feedback",
        timestamp: 0,
      },
      { id: "user-2", kind: "user", content: "More feedback", timestamp: 0 },
    ]);

    handleFeedbackPrompt(ctx, { summary: "Second feedback item." });

    expect(ctx.entries).toHaveLength(4);
    expect(ctx.entries[3]!.kind).toBe("feedback_prompt");
    expect(ctx.entries[3]!.content).toBe("Second feedback item.");
  });
});

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
  test("returns true and appends completed status for completed", () => {
    const ctx = createMockContext();

    const result = handleStatus(ctx, { status: "completed" });

    expect(result).toBe(true);
    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.kind).toBe("status");
    expect(ctx.entries[0]!.content).toBe("Session completed");
    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.calls.setSessionStatus).toEqual(["completed"]);
  });

  test("returns true and appends error status for error", () => {
    const ctx = createMockContext();

    const result = handleStatus(ctx, { status: "error" });

    expect(result).toBe(true);
    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.content).toBe("Session ended with error");
    expect(ctx.calls.setSessionStatus).toEqual(["error"]);
  });

  test("returns false and sets status for active", () => {
    const ctx = createMockContext();

    const result = handleStatus(ctx, { status: "active" });

    expect(result).toBe(false);
    expect(ctx.entries).toHaveLength(0);
    expect(ctx.calls.setSessionStatus).toEqual(["active"]);
    expect(ctx.calls.setThinking).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleError
// ---------------------------------------------------------------------------

describe("handleError", () => {
  test("appends error entry and resets pending states", () => {
    const ctx = createMockContext();
    ctx.setStreamingEntryId("e-1");

    handleError(ctx, { message: "Something went wrong" });

    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]!.kind).toBe("error");
    expect(ctx.entries[0]!.content).toBe("Something went wrong");
    expect(ctx.calls.setThinking).toEqual([false]);
    expect(ctx.calls.setPendingApproval).toEqual([false]);
    expect(ctx.calls.setPendingBackup).toEqual([false]);
    expect(ctx.getStreamingEntryId()).toBeNull();
  });
});
