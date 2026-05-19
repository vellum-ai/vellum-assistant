import { describe, expect, it } from "bun:test";
import {
  INITIAL_SUBAGENT_STATE,
  subagentReducer,
  type SubagentAction,
  type SubagentMapState,
} from "@/domains/subagents/subagent-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a sequence of actions to a state, returning the final state. */
function applyActions(
  state: SubagentMapState,
  actions: SubagentAction[],
): SubagentMapState {
  return actions.reduce(subagentReducer, state);
}

const NOW = 1700000000000;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("INITIAL_SUBAGENT_STATE", () => {
  it("starts with empty map and empty ordered list", () => {
    expect(INITIAL_SUBAGENT_STATE.byId).toEqual({});
    expect(INITIAL_SUBAGENT_STATE.orderedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SUBAGENT_SPAWNED
// ---------------------------------------------------------------------------

describe("SUBAGENT_SPAWNED", () => {
  it("adds entry with correct fields and pending status", () => {
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Research Agent",
      objective: "Find the root cause",
      isFork: false,
      timestamp: NOW,
    });

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
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-2",
      label: "Agent",
      objective: "Do something",
      timestamp: NOW,
    });

    expect(state.byId["sa-2"]!.isFork).toBe(false);
  });

  it("sets isFork to true when specified", () => {
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-3",
      label: "Fork Agent",
      objective: "Explore alternative",
      isFork: true,
      timestamp: NOW,
    });

    expect(state.byId["sa-3"]!.isFork).toBe(true);
  });

  it("deduplicates replayed SUBAGENT_SPAWNED with same id", () => {
    const spawnAction: SubagentAction = {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-dup",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    };

    const first = subagentReducer(INITIAL_SUBAGENT_STATE, spawnAction);
    expect(first.orderedIds).toEqual(["sa-dup"]);

    // Replay the same event (e.g. SSE reconnection)
    const second = subagentReducer(first, {
      ...spawnAction,
      label: "Agent Replayed",
      timestamp: NOW + 5000,
    });

    // Should return the same state reference — no duplicate entry
    expect(second).toBe(first);
    expect(second.orderedIds).toEqual(["sa-dup"]);
    expect(second.byId["sa-dup"]?.label).toBe("Agent");
  });

  it("respects explicit status from history reconstruction", () => {
    /**
     * When reconstructing from history notifications, SUBAGENT_SPAWNED carries
     * the terminal status (e.g. "completed") so the entry doesn't default to
     * "pending".
     */
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-hist",
      label: "Research Agent",
      objective: "",
      status: "completed",
      conversationId: "conv-123",
      timestamp: NOW,
    });

    expect(state.byId["sa-hist"]!.status).toBe("completed");
    expect(state.byId["sa-hist"]!.conversationId).toBe("conv-123");
  });

  it("preserves ordering when multiple agents are spawned", () => {
    const state = applyActions(INITIAL_SUBAGENT_STATE, [
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-a",
        label: "Agent A",
        objective: "Task A",
        timestamp: NOW,
      },
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-b",
        label: "Agent B",
        objective: "Task B",
        timestamp: NOW + 1000,
      },
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-c",
        label: "Agent C",
        objective: "Task C",
        timestamp: NOW + 2000,
      },
    ]);

    expect(state.orderedIds).toEqual(["sa-a", "sa-b", "sa-c"]);
    expect(Object.keys(state.byId)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SUBAGENT_STATUS_CHANGED
// ---------------------------------------------------------------------------

describe("SUBAGENT_STATUS_CHANGED", () => {
  it("updates status of existing entry", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-1",
      status: "running",
    });

    expect(state.byId["sa-1"]!.status).toBe("running");
  });

  it("updates error field when provided", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-1",
      status: "failed",
      error: "Out of context window",
    });

    expect(state.byId["sa-1"]!.status).toBe("failed");
    expect(state.byId["sa-1"]!.error).toBe("Out of context window");
  });

  it("updates token counts and cost when provided", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-1",
      status: "completed",
      inputTokens: 1500,
      outputTokens: 500,
      totalCost: 0.003,
    });

    expect(state.byId["sa-1"]!.inputTokens).toBe(1500);
    expect(state.byId["sa-1"]!.outputTokens).toBe(500);
    expect(state.byId["sa-1"]!.totalCost).toBe(0.003);
  });

  it("preserves existing values when optional fields are omitted", () => {
    const initial = applyActions(INITIAL_SUBAGENT_STATE, [
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-1",
        label: "Agent",
        objective: "Task",
        timestamp: NOW,
      },
      {
        type: "SUBAGENT_STATUS_CHANGED",
        subagentId: "sa-1",
        status: "running",
        inputTokens: 100,
        outputTokens: 50,
        totalCost: 0.001,
      },
    ]);

    const state = subagentReducer(initial, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-1",
      status: "completed",
    });

    expect(state.byId["sa-1"]!.status).toBe("completed");
    expect(state.byId["sa-1"]!.inputTokens).toBe(100);
    expect(state.byId["sa-1"]!.outputTokens).toBe(50);
    expect(state.byId["sa-1"]!.totalCost).toBe(0.001);
  });

  it("silently ignores unknown subagent ID", () => {
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-nonexistent",
      status: "running",
    });

    expect(state).toBe(INITIAL_SUBAGENT_STATE);
  });
});

// ---------------------------------------------------------------------------
// SUBAGENT_EVENT_RECEIVED
// ---------------------------------------------------------------------------

describe("SUBAGENT_EVENT_RECEIVED", () => {
  it("appends text event for assistant_text_delta", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW + 100,
    });

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    const ev = state.byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("text");
    expect(ev.content).toBe("Hello");
    expect(ev.timestamp).toBe(NOW + 100);
  });

  it("skips message_complete (no-content signal event)", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "message_complete", content: "Done" },
      timestamp: NOW + 200,
    });

    expect(state.byId["sa-1"]!.events).toHaveLength(0);
  });

  it("appends tool_call event for tool_use_start", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "file_read", content: "Reading file" },
      timestamp: NOW + 300,
    });

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    const ev = state.byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("tool_call");
    expect(ev.toolName).toBe("file_read");
  });

  it("appends tool_result event for tool_result", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "tool_result", content: "File contents here" },
      timestamp: NOW + 400,
    });

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    expect(state.byId["sa-1"]!.events[0]!.type).toBe("tool_result");
  });

  it("maps to error type when isError is true", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "tool_result", content: "Permission denied", isError: true },
      timestamp: NOW + 500,
    });

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    const ev = state.byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("error");
    expect(ev.isError).toBe(true);
  });

  it("uses empty string when content is undefined", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "tool_use_start", toolName: "bash" },
      timestamp: NOW + 600,
    });

    expect(state.byId["sa-1"]!.events[0]!.content).toBe("");
  });

  it("reads text field for assistant_text_delta when content is absent", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", text: "Hello from text field" },
      timestamp: NOW + 700,
    });

    expect(state.byId["sa-1"]!.events[0]!.content).toBe("Hello from text field");
  });

  it("reads result field for tool_result when content is absent", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "tool_result", toolName: "bash", result: "exit code 0" },
      timestamp: NOW + 800,
    });

    expect(state.byId["sa-1"]!.events[0]!.content).toBe("exit code 0");
  });

  it("prefers content over text/result when all are present", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "from content", text: "from text" },
      timestamp: NOW + 900,
    });

    expect(state.byId["sa-1"]!.events[0]!.content).toBe("from content");
  });

  it("appends events of different types in order", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = applyActions(initial, [
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "Step 1" },
        timestamp: NOW + 100,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
        timestamp: NOW + 200,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "tool_result", result: "file.txt" },
        timestamp: NOW + 300,
      },
    ]);

    expect(state.byId["sa-1"]!.events).toHaveLength(3);
    expect(state.byId["sa-1"]!.events[0]!.type).toBe("text");
    expect(state.byId["sa-1"]!.events[0]!.content).toBe("Step 1");
    expect(state.byId["sa-1"]!.events[1]!.type).toBe("tool_call");
    expect(state.byId["sa-1"]!.events[1]!.content).toBe("ls");
    expect(state.byId["sa-1"]!.events[2]!.type).toBe("tool_result");
    expect(state.byId["sa-1"]!.events[2]!.content).toBe("file.txt");
  });

  it("coalesces consecutive text deltas into one event", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = applyActions(initial, [
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "Hello" },
        timestamp: NOW + 100,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: " world" },
        timestamp: NOW + 200,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "!" },
        timestamp: NOW + 300,
      },
    ]);

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    expect(state.byId["sa-1"]!.events[0]!.content).toBe("Hello world!");
  });

  it("starts new text event after a non-text event breaks the streak", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = applyActions(initial, [
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "First" },
        timestamp: NOW + 100,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
        timestamp: NOW + 200,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "Second" },
        timestamp: NOW + 300,
      },
    ]);

    expect(state.byId["sa-1"]!.events).toHaveLength(3);
    expect(state.byId["sa-1"]!.events[0]!.content).toBe("First");
    expect(state.byId["sa-1"]!.events[1]!.type).toBe("tool_call");
    expect(state.byId["sa-1"]!.events[2]!.content).toBe("Second");
  });

  it("skips message_complete events", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = applyActions(initial, [
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "Hello" },
        timestamp: NOW + 100,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "message_complete" },
        timestamp: NOW + 200,
      },
    ]);

    expect(state.byId["sa-1"]!.events).toHaveLength(1);
    expect(state.byId["sa-1"]!.events[0]!.content).toBe("Hello");
  });

  it("summarizes tool_use_start input using priority keys", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = subagentReducer(initial, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: {
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "thermos history", options: { limit: 10 } },
      },
      timestamp: NOW + 100,
    });

    expect(state.byId["sa-1"]!.events[0]!.content).toBe("thermos history");
    expect(state.byId["sa-1"]!.events[0]!.toolName).toBe("web_search");
  });

  it("skips empty text deltas that would start a new coalesced run", () => {
    const initial = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const state = applyActions(initial, [
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "tool_use_start", toolName: "bash", input: { command: "ls" } },
        timestamp: NOW + 100,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "tool_result", result: "file.txt" },
        timestamp: NOW + 200,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "" },
        timestamp: NOW + 300,
      },
      {
        type: "SUBAGENT_EVENT_RECEIVED",
        subagentId: "sa-1",
        event: { type: "assistant_text_delta", text: "Result:" },
        timestamp: NOW + 400,
      },
    ]);

    expect(state.byId["sa-1"]!.events).toHaveLength(3);
    expect(state.byId["sa-1"]!.events[0]!.type).toBe("tool_call");
    expect(state.byId["sa-1"]!.events[1]!.type).toBe("tool_result");
    expect(state.byId["sa-1"]!.events[2]!.type).toBe("text");
    expect(state.byId["sa-1"]!.events[2]!.content).toBe("Result:");
  });

  it("silently ignores unknown subagent ID", () => {
    const state = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-nonexistent",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW,
    });

    expect(state).toBe(INITIAL_SUBAGENT_STATE);
  });
});

// ---------------------------------------------------------------------------
// SUBAGENT_RESET
// ---------------------------------------------------------------------------

describe("SUBAGENT_RESET", () => {
  it("clears all state back to initial", () => {
    const populated = applyActions(INITIAL_SUBAGENT_STATE, [
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-1",
        label: "Agent 1",
        objective: "Task 1",
        timestamp: NOW,
      },
      {
        type: "SUBAGENT_SPAWNED",
        subagentId: "sa-2",
        label: "Agent 2",
        objective: "Task 2",
        timestamp: NOW + 1000,
      },
      {
        type: "SUBAGENT_STATUS_CHANGED",
        subagentId: "sa-1",
        status: "completed",
        inputTokens: 500,
        outputTokens: 200,
      },
    ]);

    expect(populated.orderedIds).toHaveLength(2);
    expect(Object.keys(populated.byId)).toHaveLength(2);

    const state = subagentReducer(populated, { type: "SUBAGENT_RESET" });
    expect(state.byId).toEqual({});
    expect(state.orderedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("unknown action type returns state unchanged", () => {
    const state = subagentReducer(
      INITIAL_SUBAGENT_STATE,
      // @ts-expect-error — testing unknown action type
      { type: "UNKNOWN_ACTION" },
    );
    expect(state).toBe(INITIAL_SUBAGENT_STATE);
  });

  it("status change for unknown ID after reset is safe", () => {
    const populated = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const reset = subagentReducer(populated, { type: "SUBAGENT_RESET" });

    // Now try to update the old subagent — should be a no-op
    const state = subagentReducer(reset, {
      type: "SUBAGENT_STATUS_CHANGED",
      subagentId: "sa-1",
      status: "completed",
    });

    expect(state).toBe(reset);
    expect(state.byId).toEqual({});
  });

  it("event received for unknown ID after reset is safe", () => {
    const populated = subagentReducer(INITIAL_SUBAGENT_STATE, {
      type: "SUBAGENT_SPAWNED",
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    const reset = subagentReducer(populated, { type: "SUBAGENT_RESET" });

    const state = subagentReducer(reset, {
      type: "SUBAGENT_EVENT_RECEIVED",
      subagentId: "sa-1",
      event: { type: "assistant_text_delta", content: "Hello" },
      timestamp: NOW,
    });

    expect(state).toBe(reset);
    expect(state.byId).toEqual({});
  });
});
