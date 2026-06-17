import { beforeEach, describe, expect, it } from "bun:test";
import { useSubagentStore } from "@/domains/chat/subagent-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useSubagentStore.getState();
}

const NOW = 1700000000000;

beforeEach(() => {
  getState().reset();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts with empty map and empty ordered list", () => {
    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// spawnSubagent
// ---------------------------------------------------------------------------

describe("spawnSubagent", () => {
  it("adds entry with correct fields and pending status", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Research Agent",
      objective: "Find the root cause",
      isFork: false,
      timestamp: NOW,
    });

    const state = getState();
    expect(state.orderedIds).toEqual(["sa-1"]);
    const entry = state.byId["sa-1"]!;
    expect(entry).toBeDefined();
    expect(entry.subagentId).toBe("sa-1");
    expect(entry.label).toBe("Research Agent");
    expect(entry.objective).toBe("Find the root cause");
    expect(entry.status).toBe("pending");
    expect(entry.isFork).toBe(false);
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.totalCost).toBe(0);
    expect(entry.spawnedAt).toBe(NOW);
    expect(entry.events).toEqual([]);
  });

  it("defaults isFork to false when omitted", () => {
    getState().spawnSubagent({
      subagentId: "sa-2",
      label: "Agent",
      objective: "Do something",
      timestamp: NOW,
    });

    expect(getState().byId["sa-2"]!.isFork).toBe(false);
  });

  it("sets isFork to true when specified", () => {
    getState().spawnSubagent({
      subagentId: "sa-3",
      label: "Fork Agent",
      objective: "Explore alternative",
      isFork: true,
      timestamp: NOW,
    });

    expect(getState().byId["sa-3"]!.isFork).toBe(true);
  });

  it("deduplicates replayed spawn with same id", () => {
    getState().spawnSubagent({
      subagentId: "sa-dup",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const first = getState();
    expect(first.orderedIds).toEqual(["sa-dup"]);

    // Replay the same event (e.g. SSE reconnection)
    getState().spawnSubagent({
      subagentId: "sa-dup",
      label: "Agent Replayed",
      timestamp: NOW + 5000,
      objective: "Task",
    });

    const second = getState();
    expect(second.orderedIds).toEqual(["sa-dup"]);
    expect(second.byId["sa-dup"]?.label).toBe("Agent");
  });

  it("respects explicit status from history reconstruction", () => {
    /**
     * When reconstructing from history notifications, spawnSubagent carries
     * the terminal status (e.g. "completed") so the entry doesn't default to
     * "pending".
     */
    getState().spawnSubagent({
      subagentId: "sa-hist",
      label: "Research Agent",
      objective: "",
      status: "completed",
      conversationId: "conv-123",
      timestamp: NOW,
    });

    expect(getState().byId["sa-hist"]!.status).toBe("completed");
    expect(getState().byId["sa-hist"]!.conversationId).toBe("conv-123");
  });

  it("preserves ordering when multiple agents are spawned", () => {
    const store = getState();
    store.spawnSubagent({
      subagentId: "sa-a",
      label: "Agent A",
      objective: "Task A",
      timestamp: NOW,
    });
    store.spawnSubagent({
      subagentId: "sa-b",
      label: "Agent B",
      objective: "Task B",
      timestamp: NOW + 1000,
    });
    store.spawnSubagent({
      subagentId: "sa-c",
      label: "Agent C",
      objective: "Task C",
      timestamp: NOW + 2000,
    });

    const state = getState();
    expect(state.orderedIds).toEqual(["sa-a", "sa-b", "sa-c"]);
    expect(Object.keys(state.byId)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// changeStatus
// ---------------------------------------------------------------------------

describe("changeStatus", () => {
  it("updates status of existing entry", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().changeStatus({
      subagentId: "sa-1",
      status: "running",
    });

    expect(getState().byId["sa-1"]!.status).toBe("running");
  });

  it("updates error field when provided", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().changeStatus({
      subagentId: "sa-1",
      status: "failed",
      error: "Out of context window",
    });

    expect(getState().byId["sa-1"]!.status).toBe("failed");
    expect(getState().byId["sa-1"]!.error).toBe("Out of context window");
  });

  it("updates token counts and cost when provided", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().changeStatus({
      subagentId: "sa-1",
      status: "completed",
      inputTokens: 1500,
      outputTokens: 500,
      totalCost: 0.003,
    });

    expect(getState().byId["sa-1"]!.inputTokens).toBe(1500);
    expect(getState().byId["sa-1"]!.outputTokens).toBe(500);
    expect(getState().byId["sa-1"]!.totalCost).toBe(0.003);
  });

  it("preserves existing values when optional fields are omitted", () => {
    const store = getState();
    store.spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });
    store.changeStatus({
      subagentId: "sa-1",
      status: "running",
      inputTokens: 100,
      outputTokens: 50,
      totalCost: 0.001,
    });

    getState().changeStatus({
      subagentId: "sa-1",
      status: "completed",
    });

    const entry = getState().byId["sa-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(50);
    expect(entry.totalCost).toBe(0.001);
  });

  it("silently ignores unknown subagent ID", () => {
    const before = getState();
    getState().changeStatus({
      subagentId: "sa-nonexistent",
      status: "running",
    });

    expect(getState().byId).toEqual(before.byId);
    expect(getState().orderedIds).toEqual(before.orderedIds);
  });
});

// ---------------------------------------------------------------------------
// receiveEvent
// ---------------------------------------------------------------------------

describe("receiveEvent", () => {
  it("appends text event for assistant_text_delta", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW + 100,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("text");
    expect(ev.content).toBe("Hello");
    expect(ev.timestamp).toBe(NOW + 100);
  });

  it("skips message_complete (no-content signal event)", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "message_complete", content: "Done" },
      timestamp: NOW + 200,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(0);
  });

  it("appends tool_call event for tool_use_start", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "file_read", content: "Reading file" },
      timestamp: NOW + 300,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("tool_call");
    expect(ev.toolName).toBe("file_read");
  });

  it("appends tool_result event for tool_result", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", content: "File contents here" },
      timestamp: NOW + 400,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    expect(getState().byId["sa-1"]!.events[0]!.type).toBe("tool_result");
  });

  it("maps to error type when isError is true", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", content: "Permission denied", isError: true },
      timestamp: NOW + 500,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("error");
    expect(ev.isError).toBe(true);
  });

  it("uses empty string when content is undefined", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "bash" },
      timestamp: NOW + 600,
    });

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("");
  });

  it("reads text field for assistant_text_delta when content is absent", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Hello from text field" },
      timestamp: NOW + 700,
    });

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("Hello from text field");
  });

  it("reads result field for tool_result when content is absent", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", toolName: "bash", result: "exit code 0" },
      timestamp: NOW + 800,
    });

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("exit code 0");
  });

  it("prefers content over text/result when all are present", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "from content", text: "from text" },
      timestamp: NOW + 900,
    });

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("from content");
  });

  it("appends events of different types in order", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const store = getState();
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Step 1" },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
      timestamp: NOW + 200,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", result: "file.txt" },
      timestamp: NOW + 300,
    });

    const events = getState().byId["sa-1"]!.events;
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("Step 1");
    expect(events[1]!.type).toBe("tool_call");
    expect(events[1]!.content).toBe("ls");
    expect(events[2]!.type).toBe("tool_result");
    expect(events[2]!.content).toBe("file.txt");
  });

  it("coalesces consecutive text deltas into one event", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const store = getState();
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Hello" },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: " world" },
      timestamp: NOW + 200,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "!" },
      timestamp: NOW + 300,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("Hello world!");
  });

  it("starts new text event after a non-text event breaks the streak", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const store = getState();
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "First" },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
      timestamp: NOW + 200,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Second" },
      timestamp: NOW + 300,
    });

    const events = getState().byId["sa-1"]!.events;
    expect(events).toHaveLength(3);
    expect(events[0]!.content).toBe("First");
    expect(events[1]!.type).toBe("tool_call");
    expect(events[2]!.content).toBe("Second");
  });

  it("skips message_complete events", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const store = getState();
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Hello" },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "message_complete" },
      timestamp: NOW + 200,
    });

    expect(getState().byId["sa-1"]!.events).toHaveLength(1);
    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("Hello");
  });

  it("summarizes tool_use_start input using priority keys", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: {
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "thermos history", options: { limit: 10 } },
      },
      timestamp: NOW + 100,
    });

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe("thermos history");
    expect(getState().byId["sa-1"]!.events[0]!.toolName).toBe("web_search");
  });

  it("skips empty text deltas that would start a new coalesced run", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const store = getState();
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
      timestamp: NOW + 100,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", result: "file.txt" },
      timestamp: NOW + 200,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "" },
      timestamp: NOW + 300,
    });
    store.receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Result:" },
      timestamp: NOW + 400,
    });

    const events = getState().byId["sa-1"]!.events;
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[1]!.type).toBe("tool_result");
    expect(events[2]!.type).toBe("text");
    expect(events[2]!.content).toBe("Result:");
  });

  it("silently ignores unknown subagent ID", () => {
    const before = { ...getState() };
    getState().receiveEvent({
      subagentId: "sa-nonexistent",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW,
    });

    expect(getState().byId).toEqual(before.byId);
    expect(getState().orderedIds).toEqual(before.orderedIds);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears all state back to initial", () => {
    const store = getState();
    store.spawnSubagent({
      subagentId: "sa-1",
      label: "Agent 1",
      objective: "Task 1",
      timestamp: NOW,
    });
    store.spawnSubagent({
      subagentId: "sa-2",
      label: "Agent 2",
      objective: "Task 2",
      timestamp: NOW + 1000,
    });
    store.changeStatus({
      subagentId: "sa-1",
      status: "completed",
      inputTokens: 500,
      outputTokens: 200,
    });

    expect(getState().orderedIds).toHaveLength(2);
    expect(Object.keys(getState().byId)).toHaveLength(2);

    getState().reset();
    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateUsage
// ---------------------------------------------------------------------------

describe("updateUsage", () => {
  it("accumulates token deltas additively", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });
    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 200,
      outputTokens: 75,
      estimatedCost: 0.002,
    });

    const entry = getState().byId["sa-1"]!;
    expect(entry.inputTokens).toBe(300);
    expect(entry.outputTokens).toBe(125);
    expect(entry.totalCost).toBeCloseTo(0.003);
  });

  it("skips updates after terminal status with usage", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });

    // Terminal status with final usage data
    getState().changeStatus({
      subagentId: "sa-1",
      status: "completed",
      inputTokens: 500,
      outputTokens: 200,
      totalCost: 0.005,
    });

    // This should be ignored — terminal guard
    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 9999,
      outputTokens: 9999,
      estimatedCost: 99.99,
    });

    const entry = getState().byId["sa-1"]!;
    expect(entry.inputTokens).toBe(500);
    expect(entry.outputTokens).toBe(200);
    expect(entry.totalCost).toBe(0.005);
  });

  it("no-ops for unknown subagentId", () => {
    const before = { ...getState().byId };
    getState().updateUsage({
      subagentId: "sa-nonexistent",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });

    expect(getState().byId).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("status change for unknown ID after reset is safe", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().reset();

    getState().changeStatus({
      subagentId: "sa-1",
      status: "completed",
    });

    expect(getState().byId).toEqual({});
  });

  it("event received for unknown ID after reset is safe", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().reset();

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW,
    });

    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// byParent index — exercised by `TranscriptMessageBody` to avoid O(M*N)
// store scans per message body per update (fix-r1-c #2).
// ---------------------------------------------------------------------------

describe("byParent index", () => {
  it("indexes entries by parentMessageStableId and parentMessageId", () => {
    getState().spawnSubagent({
      subagentId: "sa-stable",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-stable-1",
    });
    getState().spawnSubagent({
      subagentId: "sa-daemon",
      label: "agent",
      objective: "",
      timestamp: NOW + 1,
      parentMessageId: "msg-daemon-1",
    });

    const { byParent } = getState();
    expect(byParent.get("msg-stable-1")?.map((e) => e.subagentId)).toEqual([
      "sa-stable",
    ]);
    expect(byParent.get("msg-daemon-1")?.map((e) => e.subagentId)).toEqual([
      "sa-daemon",
    ]);
  });

  it("indexes an entry under both parentMessageStableId and parentMessageId when both are distinct", () => {
    getState().spawnSubagent({
      subagentId: "sa-dual",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-stable-2",
      parentMessageId: "msg-daemon-2",
    });

    const { byParent } = getState();
    expect(byParent.get("msg-stable-2")?.[0]?.subagentId).toBe("sa-dual");
    expect(byParent.get("msg-daemon-2")?.[0]?.subagentId).toBe("sa-dual");
  });

  it("sorts each bucket by spawnedAt ascending", () => {
    getState().spawnSubagent({
      subagentId: "sa-late",
      label: "agent",
      objective: "",
      timestamp: NOW + 100,
      parentMessageStableId: "msg-x",
    });
    getState().spawnSubagent({
      subagentId: "sa-early",
      label: "agent",
      objective: "",
      timestamp: NOW + 10,
      parentMessageStableId: "msg-x",
    });

    expect(
      getState().byParent.get("msg-x")?.map((e) => e.subagentId),
    ).toEqual(["sa-early", "sa-late"]);
  });

  it("keeps the byParent map reference stable across changeStatus", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-1",
    });
    const before = getState().byParent;
    const bucketBefore = before.get("msg-1");

    getState().changeStatus({
      subagentId: "sa-1",
      status: "running",
    });

    const after = getState().byParent;
    expect(after).toBe(before);
    expect(after.get("msg-1")).toBe(bucketBefore);
  });

  it("keeps the byParent map reference stable across receiveEvent", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-1",
    });
    const before = getState().byParent;

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW,
    });

    expect(getState().byParent).toBe(before);
  });

  it("isolates buckets — adding a subagent under a different parent leaves the other bucket reference stable", () => {
    // Two distinct messages, one subagent each. Adding a third under msg-2
    // must not change the bucket for msg-1 (no re-render for msg-1's
    // subscriber).
    getState().spawnSubagent({
      subagentId: "sa-a",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-1",
    });
    getState().spawnSubagent({
      subagentId: "sa-b",
      label: "agent",
      objective: "",
      timestamp: NOW + 1,
      parentMessageStableId: "msg-2",
    });
    const bucketBefore = getState().byParent.get("msg-1");
    expect(bucketBefore?.length).toBe(1);

    getState().spawnSubagent({
      subagentId: "sa-c",
      label: "agent",
      objective: "",
      timestamp: NOW + 2,
      parentMessageStableId: "msg-2",
    });

    // msg-1's bucket reference is preserved across the unrelated spawn.
    expect(getState().byParent.get("msg-1")).toBe(bucketBefore);
    // msg-2's bucket grew.
    expect(
      getState().byParent.get("msg-2")?.map((e) => e.subagentId),
    ).toEqual(["sa-b", "sa-c"]);
  });
});

// ---------------------------------------------------------------------------
// byToolUseId index — lets the transcript anchor the inline card to its exact
// spawn tool call (toolUseId → subagentId), surviving optimistic message-id
// reconciliation.
// ---------------------------------------------------------------------------

describe("byToolUseId index", () => {
  it("indexes the subagent by parentToolUseId and sets the entry field", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentToolUseId: "tool-use-1",
    });

    expect(getState().byToolUseId.get("tool-use-1")).toBe("sa-1");
    expect(getState().byId["sa-1"]!.parentToolUseId).toBe("tool-use-1");
  });

  it("leaves byToolUseId reference-equal when parentToolUseId is omitted", () => {
    const before = getState().byToolUseId;

    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
    });

    expect(getState().byToolUseId).toBe(before);
    expect(getState().byToolUseId.size).toBe(0);
    expect(getState().byId["sa-1"]!.parentToolUseId).toBeUndefined();
  });

  it("does not touch the index when a duplicate spawn is replayed", () => {
    getState().spawnSubagent({
      subagentId: "sa-dup",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentToolUseId: "tool-use-dup",
    });
    const afterFirst = getState().byToolUseId;

    // Replay with a different toolUseId — guard short-circuits, index unchanged.
    getState().spawnSubagent({
      subagentId: "sa-dup",
      label: "agent",
      objective: "",
      timestamp: NOW + 5000,
      parentToolUseId: "tool-use-other",
    });

    expect(getState().byToolUseId).toBe(afterFirst);
    expect(getState().byToolUseId.get("tool-use-dup")).toBe("sa-dup");
    expect(getState().byToolUseId.has("tool-use-other")).toBe(false);
  });

  it("keeps the index reference stable across changeStatus and receiveEvent", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentToolUseId: "tool-use-1",
    });
    const before = getState().byToolUseId;

    getState().changeStatus({ subagentId: "sa-1", status: "running" });
    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW + 100,
    });

    expect(getState().byToolUseId).toBe(before);
  });

  it("clears byToolUseId on reset()", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentToolUseId: "tool-use-1",
    });
    expect(getState().byToolUseId.size).toBe(1);

    getState().reset();
    expect(getState().byToolUseId.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reanchorToMessage — migrate entries from the optimistic streaming bubble id
// to the durable server messageId so the subagent card survives reconcile.
// ---------------------------------------------------------------------------

describe("reanchorToMessage", () => {
  it("makes matching entries reachable under both stableId and messageId", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "stable-1",
    });

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    const { byParent, byId } = getState();
    expect(byParent.get("msg-1")?.map((e) => e.subagentId)).toEqual(["sa-1"]);
    expect(byParent.get("stable-1")?.map((e) => e.subagentId)).toEqual(["sa-1"]);
    expect(byId["sa-1"]!.parentMessageId).toBe("msg-1");
    expect(byId["sa-1"]!.parentMessageStableId).toBe("stable-1");
  });

  it("sorts the messageId bucket by spawnedAt for multiple entries under one stableId", () => {
    getState().spawnSubagent({
      subagentId: "sa-late",
      label: "agent",
      objective: "",
      timestamp: NOW + 100,
      parentMessageStableId: "stable-1",
    });
    getState().spawnSubagent({
      subagentId: "sa-early",
      label: "agent",
      objective: "",
      timestamp: NOW + 10,
      parentMessageStableId: "stable-1",
    });

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    expect(
      getState().byParent.get("msg-1")?.map((e) => e.subagentId),
    ).toEqual(["sa-early", "sa-late"]);
  });

  it("merges into an existing messageId bucket without duplicating", () => {
    // One entry already indexed under msg-1, another under the stable id only.
    getState().spawnSubagent({
      subagentId: "sa-existing",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageId: "msg-1",
    });
    getState().spawnSubagent({
      subagentId: "sa-stable",
      label: "agent",
      objective: "",
      timestamp: NOW + 50,
      parentMessageStableId: "stable-1",
    });

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    expect(
      getState().byParent.get("msg-1")?.map((e) => e.subagentId),
    ).toEqual(["sa-existing", "sa-stable"]);
  });

  it("is a no-op when stableId equals messageId", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "msg-1",
    });
    const beforeById = getState().byId;
    const beforeByParent = getState().byParent;

    getState().reanchorToMessage({ stableId: "msg-1", messageId: "msg-1" });

    expect(getState().byId).toBe(beforeById);
    expect(getState().byParent).toBe(beforeByParent);
  });

  it("is a no-op when no entry matches the stableId", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "other-stable",
    });
    const beforeById = getState().byId;
    const beforeByParent = getState().byParent;

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    expect(getState().byId).toBe(beforeById);
    expect(getState().byParent).toBe(beforeByParent);
  });

  it("is a no-op when matching entries already carry that parentMessageId", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "stable-1",
      parentMessageId: "msg-1",
    });
    const beforeById = getState().byId;
    const beforeByParent = getState().byParent;

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    expect(getState().byId).toBe(beforeById);
    expect(getState().byParent).toBe(beforeByParent);
  });

  it("preserves unrelated bucket references", () => {
    getState().spawnSubagent({
      subagentId: "sa-other",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "stable-other",
    });
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW + 1,
      parentMessageStableId: "stable-1",
    });
    const otherBucketBefore = getState().byParent.get("stable-other");

    getState().reanchorToMessage({ stableId: "stable-1", messageId: "msg-1" });

    // The unrelated bucket reference is untouched.
    expect(getState().byParent.get("stable-other")).toBe(otherBucketBefore);
  });
});
