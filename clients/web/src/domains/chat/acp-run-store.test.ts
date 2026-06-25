import { beforeEach, describe, expect, it } from "bun:test";
import {
  useAcpRunStore,
  type AcpRunEntry,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useAcpRunStore.getState();
}

const NOW = 1700000000000;

function spawn(overrides: Partial<Parameters<ReturnType<typeof getState>["spawnRun"]>[0]> = {}) {
  getState().spawnRun({
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    startedAt: NOW,
    ...overrides,
  });
}

function event(overrides: Partial<AcpRunRawEvent> = {}): AcpRunRawEvent {
  return {
    seq: 1,
    updateType: "agent_message_chunk",
    ...overrides,
  };
}

beforeEach(() => {
  getState().reset();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts empty", () => {
    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
    expect(getState().byToolUseId.size).toBe(0);
    expect(getState().highWaterMark.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spawnRun
// ---------------------------------------------------------------------------

describe("spawnRun", () => {
  it("adds an entry with running status and zeroed usage", () => {
    spawn({ task: "research the thing" });

    const entry = getState().byId["acp-1"]!;
    expect(getState().orderedIds).toEqual(["acp-1"]);
    expect(entry.agent).toBe("claude");
    expect(entry.parentConversationId).toBe("conv-1");
    expect(entry.task).toBe("research the thing");
    // Daemon emits `acp_session_spawned` only after the session is running.
    expect(entry.status).toBe("running");
    expect(entry.startedAt).toBe(NOW);
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.totalCost).toBe(0);
    expect(entry.events).toEqual([]);
  });

  it("is idempotent — a replayed spawn with the same id is ignored", () => {
    spawn();
    spawn({ agent: "replayed", startedAt: NOW + 5000 });

    expect(getState().orderedIds).toEqual(["acp-1"]);
    expect(getState().byId["acp-1"]!.agent).toBe("claude");
    expect(getState().byId["acp-1"]!.startedAt).toBe(NOW);
  });

  it("indexes byToolUseId when parentToolUseId is present", () => {
    spawn({ parentToolUseId: "tool-use-1" });

    expect(getState().byToolUseId.get("tool-use-1")).toBe("acp-1");
    expect(getState().byId["acp-1"]!.parentToolUseId).toBe("tool-use-1");
  });

  it("keeps byToolUseId reference-equal when parentToolUseId is omitted", () => {
    const before = getState().byToolUseId;
    spawn();

    expect(getState().byToolUseId).toBe(before);
    expect(getState().byToolUseId.size).toBe(0);
  });

  it("preserves ordering across multiple spawns", () => {
    spawn({ acpSessionId: "acp-a" });
    spawn({ acpSessionId: "acp-b" });
    spawn({ acpSessionId: "acp-c" });

    expect(getState().orderedIds).toEqual(["acp-a", "acp-b", "acp-c"]);
  });

  it("resumes a terminal run — clears terminal fields, marks running, keeps events", () => {
    spawn();
    getState().receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "a" }),
    });
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      stopReason: "end_turn",
      completedAt: NOW + 1000,
    });
    expect(getState().byId["acp-1"]!.status).toBe("completed");

    // A respawn for the same id (resume/steer) flips it back to running.
    spawn({ startedAt: NOW + 5000 });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.stopReason).toBeUndefined();
    expect(entry.error).toBeUndefined();
    expect(entry.completedAt).toBeUndefined();
    // Events and startedAt are preserved across the resume.
    expect(entry.events).toHaveLength(1);
    expect(entry.events[0]!.content).toBe("a");
    expect(entry.startedAt).toBe(NOW);
    // No duplicate ordered id.
    expect(getState().orderedIds).toEqual(["acp-1"]);
  });

  it("resume clears a failed run's error", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "failed",
      error: "agent crashed",
      completedAt: NOW + 2000,
    });

    spawn();

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.error).toBeUndefined();
  });

  it("backfills parentToolUseId on resume when it was previously missing", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      completedAt: NOW + 1000,
    });

    spawn({ parentToolUseId: "tool-use-1" });

    expect(getState().byId["acp-1"]!.parentToolUseId).toBe("tool-use-1");
    expect(getState().byToolUseId.get("tool-use-1")).toBe("acp-1");
  });
});

// ---------------------------------------------------------------------------
// receiveEvent
// ---------------------------------------------------------------------------

describe("receiveEvent", () => {
  it("appends an event for a known session", () => {
    spawn();
    getState().receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "hello" }),
    });

    expect(getState().byId["acp-1"]!.events).toHaveLength(1);
    expect(getState().byId["acp-1"]!.events[0]!.content).toBe("hello");
  });

  it("ignores events for an unknown session", () => {
    getState().receiveEvent({
      acpSessionId: "acp-missing",
      event: event(),
    });

    expect(getState().byId).toEqual({});
    expect(getState().highWaterMark.size).toBe(0);
  });

  it("coalesces consecutive same-messageId message chunks into one event", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "Hello", messageId: "m-1" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 2, content: " world", messageId: "m-1" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 3, content: "!", messageId: "m-1" }),
    });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("Hello world!");
    // The coalesced event's seq tracks the latest chunk.
    expect(events[0]!.seq).toBe(3);
  });

  it("coalesces consecutive same-messageId thought chunks", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, updateType: "agent_thought_chunk", content: "think", messageId: "t-1" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 2, updateType: "agent_thought_chunk", content: "ing", messageId: "t-1" }),
    });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("thinking");
  });

  it("does not coalesce chunks with different messageIds", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "first", messageId: "m-1" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 2, content: "second", messageId: "m-2" }),
    });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(2);
    expect(events[0]!.content).toBe("first");
    expect(events[1]!.content).toBe("second");
  });

  it("does not coalesce across a non-chunk event of a different type", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "msg", messageId: "m-1" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 2, updateType: "tool_call", toolCallId: "tc-1", toolTitle: "Read" }),
    });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(2);
    expect(events[1]!.updateType).toBe("tool_call");
  });

  it("does not coalesce chunks that both lack a messageId", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "a" }),
    });
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 2, content: "b" }),
    });

    expect(getState().byId["acp-1"]!.events).toHaveLength(2);
  });

  it("tracks the high-water mark monotonically", () => {
    spawn();
    const store = getState();
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 5 }) });
    expect(getState().highWaterMark.get("acp-1")).toBe(5);

    // A higher seq raises the mark.
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 9 }) });
    expect(getState().highWaterMark.get("acp-1")).toBe(9);

    // A lower (replayed) seq leaves it untouched.
    const before = getState().highWaterMark;
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 3 }) });
    expect(getState().highWaterMark.get("acp-1")).toBe(9);
    expect(getState().highWaterMark).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// setTerminal
// ---------------------------------------------------------------------------

describe("setTerminal", () => {
  it("applies status, stopReason, error, and completedAt", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      stopReason: "end_turn",
      completedAt: NOW + 1000,
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.stopReason).toBe("end_turn");
    expect(entry.completedAt).toBe(NOW + 1000);
  });

  it("records the error on a failed run", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "failed",
      error: "agent crashed",
      completedAt: NOW + 2000,
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("agent crashed");
  });

  it("ignores an unknown session", () => {
    getState().setTerminal({
      acpSessionId: "acp-missing",
      status: "cancelled",
      completedAt: NOW,
    });

    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// updateUsage
// ---------------------------------------------------------------------------

describe("updateUsage", () => {
  it("replaces the usage totals", () => {
    spawn();
    getState().updateUsage({
      acpSessionId: "acp-1",
      inputTokens: 1500,
      outputTokens: 500,
      totalCost: 0.003,
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.inputTokens).toBe(1500);
    expect(entry.outputTokens).toBe(500);
    expect(entry.totalCost).toBe(0.003);
  });

  it("ignores an unknown session", () => {
    const before = { ...getState().byId };
    getState().updateUsage({
      acpSessionId: "acp-missing",
      inputTokens: 1,
      outputTokens: 1,
      totalCost: 1,
    });

    expect(getState().byId).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// seedFromHistory
// ---------------------------------------------------------------------------

function historyEntry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    status: "completed",
    startedAt: NOW,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    events: [],
    ...overrides,
  };
}

describe("seedFromHistory", () => {
  it("adds new entries, ordered ids, byToolUseId, and highWaterMark", () => {
    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-h1",
        parentToolUseId: "tool-h1",
        events: [event({ seq: 4 }), event({ seq: 7 })],
      }),
    ]);

    expect(getState().orderedIds).toEqual(["acp-h1"]);
    expect(getState().byId["acp-h1"]!.status).toBe("completed");
    expect(getState().byToolUseId.get("tool-h1")).toBe("acp-h1");
    expect(getState().highWaterMark.get("acp-h1")).toBe(7);
  });

  it("is idempotent — re-seeding the same entry does not duplicate ordered ids", () => {
    const entry = historyEntry({ acpSessionId: "acp-h1" });
    getState().seedFromHistory([entry]);
    getState().seedFromHistory([entry]);

    expect(getState().orderedIds).toEqual(["acp-h1"]);
  });

  it("does not clobber a live entry's longer event buffer with a shorter snapshot", () => {
    spawn({ acpSessionId: "acp-1" });
    const store = getState();
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 1, content: "a" }) });
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 2, updateType: "tool_call" }) });

    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1, content: "stale" })] }),
    ]);

    // The live (longer) buffer wins.
    expect(getState().byId["acp-1"]!.events).toHaveLength(2);
    expect(getState().byId["acp-1"]!.events[0]!.content).toBe("a");
  });

  it("prefers the newer/longer historical entry over a shorter existing one", () => {
    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1 })] }),
    ]);
    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1 }), event({ seq: 2 })] }),
    ]);

    expect(getState().byId["acp-1"]!.events).toHaveLength(2);
  });

  it("merges terminal status/usage onto a live entry while keeping the longer buffer", () => {
    spawn({ acpSessionId: "acp-1" });
    const store = getState();
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 1, content: "a" }) });
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 2, updateType: "tool_call" }) });
    expect(getState().byId["acp-1"]!.status).toBe("running");

    // Equal-length terminal history snapshot must still fold in metadata.
    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        status: "completed",
        completedAt: NOW + 5000,
        stopReason: "end_turn",
        inputTokens: 1200,
        outputTokens: 340,
        totalCost: 0.012,
        events: [event({ seq: 1, content: "stale" }), event({ seq: 2 })],
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    // Longer live buffer is kept (live content, not history's "stale").
    expect(entry.events).toHaveLength(2);
    expect(entry.events[0]!.content).toBe("a");
    // Terminal metadata is merged.
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 5000);
    expect(entry.stopReason).toBe("end_turn");
    expect(entry.inputTokens).toBe(1200);
    expect(entry.outputTokens).toBe(340);
    expect(entry.totalCost).toBe(0.012);
  });

  it("does not regress a live terminal entry with empty/non-terminal history metadata", () => {
    spawn({ acpSessionId: "acp-1" });
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      stopReason: "end_turn",
      completedAt: NOW + 1000,
    });
    getState().updateUsage({
      acpSessionId: "acp-1",
      inputTokens: 900,
      outputTokens: 100,
      totalCost: 0.005,
    });

    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        status: "running",
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        events: [],
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 1000);
    expect(entry.inputTokens).toBe(900);
    expect(entry.outputTokens).toBe(100);
    expect(entry.totalCost).toBe(0.005);
  });

  it("backfills a missing task from history", () => {
    spawn({ acpSessionId: "acp-1", task: undefined });
    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", task: "recovered task" }),
    ]);

    expect(getState().byId["acp-1"]!.task).toBe("recovered task");
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears all state back to initial", () => {
    spawn({ parentToolUseId: "tool-1" });
    getState().receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 3 }) });

    getState().reset();

    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
    expect(getState().byToolUseId.size).toBe(0);
    expect(getState().highWaterMark.size).toBe(0);
  });
});
