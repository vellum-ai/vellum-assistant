import { beforeEach, describe, expect, it } from "bun:test";
import {
  useAcpRunStore,
  type AcpRunEntry,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import { computeAcpRunSteps } from "@/domains/chat/acp-run-step-projection";

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
    expect(entry.usedTokens).toBe(0);
    expect(entry.contextSize).toBe(0);
    expect(entry.costAmount).toBeUndefined();
    expect(entry.costCurrency).toBeUndefined();
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

  it("stores each message chunk as its own event (coalescing is the projection's job)", () => {
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

    // The raw buffer stays un-coalesced so history reconciliation can dedup by
    // seq; the step projection concatenates these into one rendered message.
    const events = getState().byId["acp-1"]!.events;
    expect(events.map((e) => e.content)).toEqual(["Hello", " world", "!"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("stores each thought chunk as its own event", () => {
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
    expect(events.map((e) => e.content)).toEqual(["think", "ing"]);
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
// appendLocalMarker
// ---------------------------------------------------------------------------

describe("appendLocalMarker", () => {
  it("appends a marker without advancing the high-water mark", () => {
    spawn();
    const store = getState();
    // Catch the client up to seq N — the normal steer-time case.
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 5, content: "a" }) });
    expect(getState().highWaterMark.get("acp-1")).toBe(5);

    store.appendLocalMarker({ acpSessionId: "acp-1", content: "↻ Steering: go" });

    const events = getState().byId["acp-1"]!.events;
    const marker = events[events.length - 1]!;
    expect(marker.content).toBe("↻ Steering: go");
    expect(marker.updateType).toBe("agent_message_chunk");
    // Fractional seq sorts after seq 5 but is never a real daemon integer seq.
    expect(marker.seq).toBe(5.5);
    // Crucially, the dedup high-water mark is UNCHANGED.
    expect(getState().highWaterMark.get("acp-1")).toBe(5);

    // The projection renders the marker as a trailing message step.
    const steps = computeAcpRunSteps(events);
    const lastStep = steps[steps.length - 1]!;
    expect(lastStep.kind).toBe("message");
    expect(lastStep.kind === "message" && lastStep.content).toBe("↻ Steering: go");
  });

  it("does not coalesce into an adjacent real message — uses a unique messageId", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "real", messageId: "m-1" }),
    });

    store.appendLocalMarker({ acpSessionId: "acp-1", content: "↻ Steering: go" });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(2);
    expect(events[1]!.messageId).not.toBe("m-1");
  });

  it("keeps the next real daemon event after a marker — it is not dropped by the dedup gate", () => {
    spawn();
    const store = getState();
    // Client is caught up at seq N when the steer fires.
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 5, content: "a" }) });
    store.appendLocalMarker({ acpSessionId: "acp-1", content: "↻ Steering: go" });

    // Simulate the SSE dedup gate (acp-handlers): drop seq <= hwm, else apply.
    const hwm = getState().highWaterMark.get("acp-1") ?? -1;
    const nextSeq = 6; // daemon's contiguous ++lastSeq
    expect(nextSeq).toBeGreaterThan(hwm);
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: nextSeq, content: "post-steer", messageId: "m-post" }),
    });

    // The daemon's first real post-steer event survives.
    const events = getState().byId["acp-1"]!.events;
    expect(events.some((e) => e.content === "post-steer")).toBe(true);
    expect(getState().highWaterMark.get("acp-1")).toBe(6);
  });

  it("ignores an unknown session", () => {
    getState().appendLocalMarker({ acpSessionId: "acp-missing", content: "x" });
    expect(getState().byId).toEqual({});
  });

  it("returns the marker id, or null for an unknown session", () => {
    spawn();
    const markerId = getState().appendLocalMarker({
      acpSessionId: "acp-1",
      content: "↻ Steering: go",
    });
    const events = getState().byId["acp-1"]!.events;
    expect(markerId).toBe(events[events.length - 1]!.messageId!);

    expect(
      getState().appendLocalMarker({ acpSessionId: "acp-missing", content: "x" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removeLocalMarker
// ---------------------------------------------------------------------------

describe("removeLocalMarker", () => {
  it("removes the marker appended by its id (steer rollback)", () => {
    spawn();
    const store = getState();
    store.receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "real", messageId: "m-1" }),
    });
    const markerId = store.appendLocalMarker({
      acpSessionId: "acp-1",
      content: "↻ Steering: go",
    })!;
    expect(getState().byId["acp-1"]!.events).toHaveLength(2);

    getState().removeLocalMarker({ acpSessionId: "acp-1", markerId });

    const events = getState().byId["acp-1"]!.events;
    expect(events).toHaveLength(1);
    expect(events.some((e) => e.content === "↻ Steering: go")).toBe(false);
    // The real event is untouched.
    expect(events[0]!.messageId).toBe("m-1");
  });

  it("is a no-op for an unknown marker id or session", () => {
    spawn();
    getState().receiveEvent({
      acpSessionId: "acp-1",
      event: event({ seq: 1, content: "real", messageId: "m-1" }),
    });
    const before = getState().byId["acp-1"]!.events;

    getState().removeLocalMarker({ acpSessionId: "acp-1", markerId: "nope" });
    getState().removeLocalMarker({ acpSessionId: "acp-missing", markerId: "x" });

    // Same array reference — no state churn when nothing matched.
    expect(getState().byId["acp-1"]!.events).toBe(before);
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
// cancelRun
// ---------------------------------------------------------------------------

describe("cancelRun", () => {
  it("marks an active run cancelled with completedAt", () => {
    spawn();
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: NOW + 3000 });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("cancelled");
    expect(entry.completedAt).toBe(NOW + 3000);
  });

  it("does not regress an already-terminal run", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      stopReason: "end_turn",
      completedAt: NOW + 1000,
    });
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: NOW + 3000 });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 1000);
  });

  it("ignores an unknown session", () => {
    getState().cancelRun({ acpSessionId: "acp-missing", completedAt: NOW });
    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// restoreRunStatus
// ---------------------------------------------------------------------------

describe("restoreRunStatus", () => {
  it("reverts an optimistic cancel to the prior status and clears completedAt", () => {
    spawn();
    getState().cancelRun({ acpSessionId: "acp-1", completedAt: NOW });
    expect(getState().byId["acp-1"]!.status).toBe("cancelled");

    getState().restoreRunStatus({ acpSessionId: "acp-1", status: "running" });

    expect(getState().byId["acp-1"]!.status).toBe("running");
    expect(getState().byId["acp-1"]!.completedAt).toBeUndefined();
  });

  it("is a no-op once a real terminal has landed (never regresses to active)", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      completedAt: NOW,
    });
    getState().restoreRunStatus({ acpSessionId: "acp-1", status: "running" });
    expect(getState().byId["acp-1"]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// retireMissingRuns
// ---------------------------------------------------------------------------

describe("retireMissingRuns", () => {
  it("marks an active run cancelled with a daemon_restarted stop reason", () => {
    spawn();
    getState().retireMissingRuns({ acpSessionIds: ["acp-1"], completedAt: NOW });

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("cancelled");
    expect(entry.stopReason).toBe("daemon_restarted");
    expect(entry.completedAt).toBe(NOW);
  });

  it("leaves an already-terminal run untouched", () => {
    spawn();
    getState().setTerminal({
      acpSessionId: "acp-1",
      status: "completed",
      completedAt: NOW,
    });
    getState().retireMissingRuns({
      acpSessionIds: ["acp-1"],
      completedAt: NOW + 1,
    });
    expect(getState().byId["acp-1"]!.status).toBe("completed");
  });

  it("ignores unknown ids without touching state", () => {
    spawn();
    const before = getState().byId;
    getState().retireMissingRuns({ acpSessionIds: ["nope"], completedAt: NOW });
    expect(getState().byId).toBe(before);
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
      usedTokens: 1500,
      contextSize: 200000,
      costAmount: 0.003,
      costCurrency: "USD",
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.usedTokens).toBe(1500);
    expect(entry.contextSize).toBe(200000);
    expect(entry.costAmount).toBe(0.003);
    expect(entry.costCurrency).toBe("USD");
  });

  it("sets cumulative input/output tokens", () => {
    spawn();
    getState().updateUsage({
      acpSessionId: "acp-1",
      usedTokens: 1500,
      contextSize: 200000,
      inputTokens: 12000,
      outputTokens: 3400,
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.inputTokens).toBe(12000);
    expect(entry.outputTokens).toBe(3400);
  });

  it("preserves cumulative input/output/cost when a later event omits them", () => {
    spawn();
    // A prompt finishes carrying the cumulative totals + cost.
    getState().updateUsage({
      acpSessionId: "acp-1",
      usedTokens: 1500,
      contextSize: 200000,
      inputTokens: 12000,
      outputTokens: 3400,
      costAmount: 0.05,
      costCurrency: "USD",
    });
    // A subsequent streaming usage_update carries only used/size (no totals).
    getState().updateUsage({
      acpSessionId: "acp-1",
      usedTokens: 1800,
      contextSize: 200000,
    });

    const entry = getState().byId["acp-1"]!;
    expect(entry.usedTokens).toBe(1800);
    expect(entry.inputTokens).toBe(12000);
    expect(entry.outputTokens).toBe(3400);
    expect(entry.costAmount).toBe(0.05);
    expect(entry.costCurrency).toBe("USD");
  });

  it("ignores an unknown session", () => {
    const before = { ...getState().byId };
    getState().updateUsage({
      acpSessionId: "acp-missing",
      usedTokens: 1,
      contextSize: 1,
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
    usedTokens: 0,
    contextSize: 0,
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

  it("does not clobber a live entry's events with a shorter snapshot", () => {
    spawn({ acpSessionId: "acp-1" });
    const store = getState();
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 1, content: "a" }) });
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 2, updateType: "tool_call" }) });

    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1, content: "stale" })] }),
    ]);

    // Seq union keeps both live events; the live seq=1 wins over history's.
    expect(getState().byId["acp-1"]!.events).toHaveLength(2);
    expect(getState().byId["acp-1"]!.events[0]!.content).toBe("a");
  });

  it("unions seqs from a longer historical entry into a shorter existing one", () => {
    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1 })] }),
    ]);
    getState().seedFromHistory([
      historyEntry({ acpSessionId: "acp-1", events: [event({ seq: 1 }), event({ seq: 2 })] }),
    ]);

    expect(getState().byId["acp-1"]!.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps the newest live event when history is longer but has a lower max seq", () => {
    spawn({ acpSessionId: "acp-1" });
    const store = getState();
    // Live store received only the newest events (high seqs) before the HTTP
    // snapshot resolved.
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 9, content: "live-9" }) });
    store.receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 10, updateType: "tool_call", toolCallId: "live-10" }) });
    expect(getState().highWaterMark.get("acp-1")).toBe(10);

    // A stale-but-longer history snapshot: more events, but max seq 4 < 10.
    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        events: [event({ seq: 1 }), event({ seq: 2 }), event({ seq: 3 }), event({ seq: 4 })],
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    const seqs = entry.events.map((e) => e.seq);
    // The newest live event survives, older history events fill in, all unioned.
    expect(seqs).toEqual([1, 2, 3, 4, 9, 10]);
    expect(entry.events.find((e) => e.seq === 9)!.content).toBe("live-9");
    expect(entry.events.find((e) => e.seq === 10)!.toolCallId).toBe("live-10");
    // highWaterMark reflects the true newest seq, not the incoming-only max.
    expect(getState().highWaterMark.get("acp-1")).toBe(10);
  });

  it("appends events lacking a seq without deduping them", () => {
    spawn({ acpSessionId: "acp-1" });
    getState().receiveEvent({ acpSessionId: "acp-1", event: event({ seq: 5, content: "live" }) });

    const seqless = { updateType: "tool_call", toolCallId: "no-seq" } as AcpRunRawEvent;
    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        events: [event({ seq: 1 }), seqless, seqless],
      }),
    ]);

    const events = getState().byId["acp-1"]!.events;
    // seq 1 + seq 5, then both seqless events appended (not collapsed).
    expect(events.filter((e) => typeof e.seq === "number").map((e) => e.seq)).toEqual([1, 5]);
    expect(events.filter((e) => e.toolCallId === "no-seq")).toHaveLength(2);
    // highWaterMark ignores seqless events.
    expect(getState().highWaterMark.get("acp-1")).toBe(5);
  });

  it("merges terminal status/usage onto a live entry while unioning events", () => {
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
        usedTokens: 1200,
        contextSize: 200000,
        costAmount: 0.012,
        costCurrency: "USD",
        events: [event({ seq: 1, content: "stale" }), event({ seq: 2 })],
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    // Seq union: live seq=1 wins over history's "stale", seq=2 unioned.
    expect(entry.events).toHaveLength(2);
    expect(entry.events[0]!.content).toBe("a");
    // Terminal metadata is merged.
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 5000);
    expect(entry.stopReason).toBe("end_turn");
    expect(entry.usedTokens).toBe(1200);
    expect(entry.contextSize).toBe(200000);
    expect(entry.costAmount).toBe(0.012);
    expect(entry.costCurrency).toBe("USD");
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
      usedTokens: 900,
      contextSize: 200000,
      costAmount: 0.005,
      costCurrency: "USD",
    });

    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        status: "running",
        usedTokens: 0,
        contextSize: 0,
        events: [],
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 1000);
    expect(entry.usedTokens).toBe(900);
    expect(entry.contextSize).toBe(200000);
    expect(entry.costAmount).toBe(0.005);
    expect(entry.costCurrency).toBe("USD");
  });

  it("folds persisted input/output tokens onto a live entry", () => {
    spawn({ acpSessionId: "acp-1" });
    getState().seedFromHistory([
      historyEntry({
        acpSessionId: "acp-1",
        status: "completed",
        completedAt: NOW + 5000,
        inputTokens: 12000,
        outputTokens: 3400,
      }),
    ]);

    const entry = getState().byId["acp-1"]!;
    expect(entry.inputTokens).toBe(12000);
    expect(entry.outputTokens).toBe(3400);
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
