import { beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test";
import type { SubagentInnerEvent } from "@vellumai/assistant-api";

let selfLookupSupported = true;
mock.module("@/lib/backwards-compat/subagent-detail-self-lookup", () => ({
  supportsSubagentDetailSelfLookup: () => selfLookupSupported,
}));

let reconcileSupported = true;
mock.module("@/lib/backwards-compat/subagents-reconcile", () => ({
  supportsSubagentsReconcile: () => reconcileSupported,
}));

const fetchSubagentDetail = mock(
  async (
    _assistantId: string,
    _subagentId: string,
    _conversationId: string,
  ): Promise<null> => null,
);
mock.module("./fetch-subagent-detail", () => ({ fetchSubagentDetail }));

interface ReconcileReply {
  ok: boolean;
  subagents?: Record<string, Record<string, unknown>>;
}

const reconcileRequests: Array<{
  path?: Record<string, string>;
  query?: Record<string, unknown>;
}> = [];
let reconcileReply: ReconcileReply = { ok: true, subagents: {} };
const subagentsReconcileGet = mock(
  async (options: {
    path?: Record<string, string>;
    query?: Record<string, unknown>;
  }) => {
    reconcileRequests.push(options);
    // Force at least one microtask hop so a second caller can join the
    // in-flight promise before the first resolves.
    await Promise.resolve();
    return {
      data: reconcileReply.ok
        ? { subagents: reconcileReply.subagents ?? {} }
        : undefined,
      response: { ok: reconcileReply.ok, status: reconcileReply.ok ? 200 : 500 },
    };
  },
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  subagentsReconcileGet,
  subagentsByIdAbortPost: mock(async () => ({ data: undefined, response: { ok: true } })),
}));

const actualDiagnostics = await import("@/lib/diagnostics");
const recordedDiagnostics: Array<{
  kind: string;
  details: Record<string, unknown>;
}> = [];
mock.module("@/lib/diagnostics", () => ({
  ...actualDiagnostics,
  recordDiagnostic: (kind: string, details: Record<string, unknown> = {}) => {
    recordedDiagnostics.push({ kind, details });
  },
}));

const { useSubagentStore } = await import("@/domains/chat/subagent-store");
// Imported after the SDK mock so it binds to the same mocked store module.
const { reconcileSubagentStoreFromNotifications } = await import(
  "@/domains/chat/hooks/reconcile-subagent-hydration"
);
const { useConversationStore } = await import("@/stores/conversation-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useSubagentStore.getState();
}

const NOW = 1700000000000;

/**
 * Step the clock past a parent's reconcile window so the next call is a real
 * round-trip rather than a throttled no-op.
 */
function advancePastReconcileWindow() {
  setSystemTime(new Date(Date.now() + 10_000));
}

/** Every `subagent_reconcile_kick` recorded since the current test started. */
function reconcileKicks() {
  return recordedDiagnostics.filter(
    (event) => event.kind === "subagent_reconcile_kick",
  );
}

beforeEach(() => {
  setSystemTime();
  getState().reset();
  useConversationStore.getState().setActiveConversationId(null);
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  selfLookupSupported = true;
  reconcileSupported = true;
  fetchSubagentDetail.mockClear();
  subagentsReconcileGet.mockClear();
  reconcileRequests.length = 0;
  reconcileReply = { ok: true, subagents: {} };
  recordedDiagnostics.length = 0;
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

  it("stores the parent conversation id separately from the child one", () => {
    getState().spawnSubagent({
      subagentId: "sa-parented",
      label: "Agent",
      objective: "",
      conversationId: "conv-child",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });

    const entry = getState().byId["sa-parented"]!;
    expect(entry.conversationId).toBe("conv-child");
    expect(entry.parentConversationId).toBe("conv-parent");
  });
});

// ---------------------------------------------------------------------------
// setParentConversationId
// ---------------------------------------------------------------------------

describe("setParentConversationId", () => {
  it("stamps the parent conversation id without touching the child one", () => {
    getState().spawnSubagent({
      subagentId: "sa-p",
      label: "Agent",
      objective: "",
      conversationId: "conv-child",
      timestamp: NOW,
    });

    getState().setParentConversationId("sa-p", "conv-parent");

    const entry = getState().byId["sa-p"]!;
    expect(entry.parentConversationId).toBe("conv-parent");
    expect(entry.conversationId).toBe("conv-child");
  });

  it("no-ops for an unknown subagent id", () => {
    getState().setParentConversationId("sa-missing", "conv-parent");

    expect(getState().byId["sa-missing"]).toBeUndefined();
  });

  it("preserves entry identity when the value is unchanged", () => {
    getState().spawnSubagent({
      subagentId: "sa-same",
      label: "Agent",
      objective: "",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    const before = getState().byId["sa-same"]!;

    getState().setParentConversationId("sa-same", "conv-parent");

    expect(getState().byId["sa-same"]).toBe(before);
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

  it("preserves accumulated tokens when an abort ships zero usage", () => {
    // Stop button → the daemon emits an abort status carrying `usage: {0,0,0}`.
    // The already-spent tokens must survive (not flush to zero) — `||`, not
    // `??`, so the incoming 0 falls back to the running tally.
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
      inputTokens: 1200,
      outputTokens: 340,
      totalCost: 0.002,
    });

    getState().changeStatus({
      subagentId: "sa-1",
      status: "aborted",
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    });

    const entry = getState().byId["sa-1"]!;
    expect(entry.status).toBe("aborted");
    expect(entry.inputTokens).toBe(1200);
    expect(entry.outputTokens).toBe(340);
    expect(entry.totalCost).toBe(0.002);
  });

  it("still applies a real non-zero terminal total over the running tally", () => {
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
      inputTokens: 1200,
      outputTokens: 340,
      totalCost: 0.002,
    });

    // Completion ships the authoritative final totals — non-zero, so they
    // replace the running tally (the abort guard only catches zeros).
    getState().changeStatus({
      subagentId: "sa-1",
      status: "completed",
      inputTokens: 1500,
      outputTokens: 500,
      totalCost: 0.003,
    });

    const entry = getState().byId["sa-1"]!;
    expect(entry.inputTokens).toBe(1500);
    expect(entry.outputTokens).toBe(500);
    expect(entry.totalCost).toBe(0.003);
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
      event: {
        type: "tool_use_start",
        toolName: "file_read",
        content: "Reading file",
      },
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

  it("captures the web_search query from a tool_result's activityMetadata", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      // `activityMetadata` rides through on the subagent wire as a passthrough
      // field (not on the inferred `SubagentInnerEvent` type), so cast to attach
      // it — this is the only live source of the web_search query, since the
      // originating `tool_use_start` carries empty input.
      event: {
        type: "tool_result",
        toolName: "web_search",
        toolUseId: "tu-ws",
        result: "Title\nhttps://example.com",
        activityMetadata: {
          webSearch: {
            query: "best thermos 2025",
            provider: "anthropic-native",
            resultCount: 1,
            durationMs: 120,
            results: [],
          },
        },
      } as SubagentInnerEvent,
      timestamp: NOW + 700,
    });

    expect(getState().byId["sa-1"]!.events[0]!.searchQuery).toBe(
      "best thermos 2025",
    );
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
      event: {
        type: "tool_result",
        content: "Permission denied",
        isError: true,
      },
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

    expect(getState().byId["sa-1"]!.events[0]!.content).toBe(
      "Hello from text field",
    );
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
      event: {
        type: "assistant_text_delta",
        content: "from content",
        text: "from text",
      },
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
      event: {
        type: "tool_use_start",
        toolName: "bash",
        input: { command: "ls" },
      },
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
      event: {
        type: "tool_use_start",
        toolName: "bash",
        input: { command: "ls" },
      },
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
      event: {
        type: "tool_use_start",
        toolName: "bash",
        input: { command: "ls" },
      },
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

  it("preserves raw input on tool_use_start alongside the content summary", () => {
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
        toolName: "bash",
        input: { command: "ls -la" },
      },
      timestamp: NOW + 100,
    });

    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("tool_call");
    expect(ev.input?.command).toBe("ls -la");
    // The summary that drives labels is still derived from the input.
    expect(ev.content).toBe("ls -la");
    expect(ev.result).toBeUndefined();
  });

  it("preserves raw result on tool_result", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", result: "total 0\nfile.txt" },
      timestamp: NOW + 200,
    });

    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("tool_result");
    expect(ev.result).toBe("total 0\nfile.txt");
    expect(ev.input).toBeUndefined();
  });

  it("preserves result on an errored tool_result (mapped to type error)", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: {
        type: "tool_result",
        toolName: "bash",
        result: "Error: command not found: foo",
        isError: true,
      },
      timestamp: NOW + 400,
    });

    const ev = getState().byId["sa-1"]!.events[0]!;
    // mapInnerEventType routes isError to "error", but the raw result must
    // still be retained for the detail view.
    expect(ev.type).toBe("error");
    expect(ev.isError).toBe(true);
    expect(ev.result).toBe("Error: command not found: foo");
  });

  it("falls back to content for tool_result result when result is absent", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: { type: "tool_result", content: "File contents here" },
      timestamp: NOW + 300,
    });

    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.type).toBe("tool_result");
    expect(ev.result).toBe("File contents here");
  });

  it("leaves input/result unset for text events", () => {
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

    const ev = getState().byId["sa-1"]!.events[0]!;
    expect(ev.input).toBeUndefined();
    expect(ev.result).toBeUndefined();
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
      getState()
        .byParent.get("msg-x")
        ?.map((e) => e.subagentId),
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
      getState()
        .byParent.get("msg-2")
        ?.map((e) => e.subagentId),
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
    expect(byParent.get("stable-1")?.map((e) => e.subagentId)).toEqual([
      "sa-1",
    ]);
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
      getState()
        .byParent.get("msg-1")
        ?.map((e) => e.subagentId),
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
      getState()
        .byParent.get("msg-1")
        ?.map((e) => e.subagentId),
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

// ---------------------------------------------------------------------------
// ensureEntry — stub recovery for a missed subagent_spawned (LUM-2875)
// ---------------------------------------------------------------------------

describe("ensureEntry", () => {
  it("creates a running stub with placeholder identity", () => {
    getState().ensureEntry({ subagentId: "sa-1", timestamp: NOW });

    const entry = getState().byId["sa-1"];
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("");
    expect(entry?.status).toBe("running");
    expect(entry?.events).toEqual([]);
    expect(entry?.hydrationPending).toBeUndefined();
    expect(getState().orderedIds).toEqual(["sa-1"]);
  });

  it("marks the stub hydrationPending when a conversationId arms the backfill", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      conversationId: "conv-child",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.conversationId).toBe("conv-child");
    expect(entry?.hydrationPending).toBe(true);
  });

  it("arms on the child id even on a pre-0.11.0 daemon", () => {
    // The child id addresses the subagent's own conversation, so an old
    // daemon trusting it verbatim still parses the right messages.
    selfLookupSupported = false;

    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      conversationId: "conv-child",
      parentConversationId: "conv-parent",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.conversationId).toBe("conv-child");
    expect(entry?.parentConversationId).toBe("conv-parent");
    expect(entry?.hydrationPending).toBe(true);
  });

  it("arms on a parent-only stub without polluting the child field", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      parentConversationId: "conv-parent",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.parentConversationId).toBe("conv-parent");
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.hydrationPending).toBe(true);
  });

  it("leaves a parent-only stub un-armed on a pre-0.11.0 daemon", () => {
    selfLookupSupported = false;

    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      parentConversationId: "conv-parent",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.parentConversationId).toBe("conv-parent");
    expect(entry?.conversationId).toBeUndefined();
    expect(entry?.hydrationPending).toBeUndefined();
  });

  it("is a no-op when the entry already exists", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "real label",
      objective: "obj",
      timestamp: NOW,
    });

    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW + 5,
      conversationId: "conv-x",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("real label");
    expect(entry?.hydrationPending).toBeUndefined();
  });

  it("accepts a terminal status for a stub recovered from a status event", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      status: "completed",
    });

    expect(getState().byId["sa-1"]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// hydrationPending — live events defer to the authoritative backfill
// ---------------------------------------------------------------------------

describe("hydrationPending", () => {
  const textEvent: SubagentInnerEvent = {
    type: "assistant_text_delta",
    text: "hello",
  };

  it("receiveEvent drops events while the backfill is outstanding", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      conversationId: "conv-child",
    });

    getState().receiveEvent({
      subagentId: "sa-1",
      event: textEvent,
      timestamp: NOW + 1,
    });

    expect(getState().byId["sa-1"]?.events).toEqual([]);
  });

  it("loadDetail clears the flag and subsequent events append", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      conversationId: "conv-child",
    });

    getState().loadDetail({ subagentId: "sa-1", events: [] });

    expect(getState().byId["sa-1"]?.hydrationPending).toBe(false);

    getState().receiveEvent({
      subagentId: "sa-1",
      event: textEvent,
      timestamp: NOW + 2,
    });
    expect(getState().byId["sa-1"]?.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadDetail — identity backfill for recovered stubs
// ---------------------------------------------------------------------------

describe("loadDetail identity backfill", () => {
  it("backfills label and parentToolUseId onto a stub and indexes the anchor", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      conversationId: "conv-child",
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      label: "Audit daemon defenses",
      parentToolUseId: "toolu_1",
    });

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("Audit daemon defenses");
    expect(entry?.parentToolUseId).toBe("toolu_1");
    expect(getState().byToolUseId.get("toolu_1")).toBe("sa-1");
  });

  it("keeps a label learned from subagent_spawned over the fetched one", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "spawn label",
      objective: "obj",
      timestamp: NOW,
      conversationId: "conv-child",
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      label: "fetched label",
    });

    expect(getState().byId["sa-1"]?.label).toBe("spawn label");
  });

  it("does not re-index or clobber an existing parentToolUseId", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      timestamp: NOW,
      parentToolUseId: "toolu_original",
    });
    const byToolUseIdBefore = getState().byToolUseId;

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      parentToolUseId: "toolu_other",
    });

    expect(getState().byId["sa-1"]?.parentToolUseId).toBe("toolu_original");
    expect(getState().byToolUseId).toBe(byToolUseIdBefore);
  });

  it("never walks a settled entry back to an active status", () => {
    // The fetch was issued while the run was live; its answer landed after the
    // terminal event. Nothing further is coming, so a regression here would
    // strand the card `running` forever.
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      status: "completed",
      timestamp: NOW,
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      status: "running",
    });

    expect(getState().byId["sa-1"]?.status).toBe("completed");
  });

  it("applies a terminal status to a live entry", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "agent",
      objective: "",
      status: "running",
      timestamp: NOW,
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      status: "completed",
    });

    expect(getState().byId["sa-1"]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// fetchDetailIfNeeded: which conversation id addresses the subagent
// ---------------------------------------------------------------------------

describe("fetchDetailIfNeeded conversation id", () => {
  it("queries with the child id when the entry knows it", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      conversationId: "conv-child",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    expect(fetchSubagentDetail).toHaveBeenCalledWith(
      "assistant-1",
      "sa-1",
      "conv-child",
    );
  });

  it("falls back to the parent id only on a self-lookup daemon", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    expect(fetchSubagentDetail).toHaveBeenCalledWith(
      "assistant-1",
      "sa-1",
      "conv-parent",
    );
  });

  it("does not fetch with a parent-only entry on a pre-0.11.0 daemon", async () => {
    selfLookupSupported = false;
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    expect(fetchSubagentDetail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchDetailIfNeeded: detailSettled marks a completed fetch
// ---------------------------------------------------------------------------

describe("fetchDetailIfNeeded detailSettled", () => {
  function spawnTerminal(id: string) {
    getState().spawnSubagent({
      subagentId: id,
      label: "Agent",
      objective: "",
      status: "completed",
      conversationId: "conv-child",
      timestamp: NOW,
    });
  }

  it("sets detailSettled on a success (events) fetch", async () => {
    spawnTerminal("sa-1");
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "completed",
      events: [{ type: "text", content: "hello" }],
    } as never);

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    const entry = getState().byId["sa-1"]!;
    expect(entry.detailSettled).toBe(true);
    expect(entry.events.length).toBeGreaterThan(0);
  });

  it("sets detailSettled on an empty-result fetch", async () => {
    spawnTerminal("sa-1");
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "completed",
      events: [],
    } as never);

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    const entry = getState().byId["sa-1"]!;
    expect(entry.detailSettled).toBe(true);
    expect(entry.events).toEqual([]);
  });

  it("sets detailSettled on a failed fetch", async () => {
    spawnTerminal("sa-1");
    // Default mock resolves to null (fetch failure).
    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    expect(getState().byId["sa-1"]?.detailSettled).toBe(true);
  });

  it("is a no-op when the entry was disposed mid-flight", async () => {
    spawnTerminal("sa-1");
    fetchSubagentDetail.mockImplementationOnce(async () => {
      // The conversation switches away while the fetch is outstanding.
      getState().reset();
      return null;
    });

    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    expect(getState().byId["sa-1"]).toBeUndefined();
  });

  it("re-arms an empty mid-run settle when the run goes terminal, so the fetch retries", async () => {
    // A fetch that settles empty while the run is LIVE answers "no events
    // yet", not "no events ever". If the run then finishes without streaming
    // its events here, the terminal transition must clear `detailSettled` so
    // the render-driven fetch asks again; otherwise the card rests on
    // "Finished, 0 steps" with the real timeline permanently unfetched.
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "running",
      conversationId: "conv-child",
      timestamp: NOW,
    });
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "running",
      events: [],
    } as never);
    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");
    expect(getState().byId["sa-1"]?.detailSettled).toBe(true);

    getState().changeStatus({ subagentId: "sa-1", status: "completed" });
    expect(getState().byId["sa-1"]?.detailSettled).toBe(false);

    // The retry actually goes out and lands the final timeline.
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "completed",
      events: [{ type: "text", content: "done" }],
    } as never);
    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");
    const entry = getState().byId["sa-1"]!;
    expect(entry.detailSettled).toBe(true);
    expect(entry.events.length).toBeGreaterThan(0);
  });

  it("keeps a settled flag across the terminal transition when events exist", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "running",
      conversationId: "conv-child",
      timestamp: NOW,
    });
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "running",
      events: [{ type: "text", content: "hello" }],
    } as never);
    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    getState().changeStatus({ subagentId: "sa-1", status: "completed" });

    expect(getState().byId["sa-1"]?.detailSettled).toBe(true);
  });

  it("keeps a settled flag on a terminal-to-terminal status apply", async () => {
    // A reconcile snapshot re-applying a terminal status must not re-arm the
    // flag: only the live-to-terminal transition invalidates an empty settle.
    spawnTerminal("sa-1");
    fetchSubagentDetail.mockResolvedValueOnce({
      status: "completed",
      events: [],
    } as never);
    await getState().fetchDetailIfNeeded("assistant-1", "sa-1");

    getState().changeStatus({ subagentId: "sa-1", status: "failed" });

    expect(getState().byId["sa-1"]?.detailSettled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadDetail: child conversation id resolved by the daemon
// ---------------------------------------------------------------------------

describe("loadDetail conversation id", () => {
  it("stamps the resolved child conversation onto a parent-only stub", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      parentConversationId: "conv-parent",
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      conversationId: "conv-child",
    });

    expect(getState().byId["sa-1"]?.conversationId).toBe("conv-child");
  });

  it("ignores a conversation id that is just the queried parent echoed back", () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      parentConversationId: "conv-parent",
    });

    getState().loadDetail({
      subagentId: "sa-1",
      events: [],
      conversationId: "conv-parent",
    });

    expect(getState().byId["sa-1"]?.conversationId).toBeUndefined();
  });

  it("keeps the existing child id when the detail omits one", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      conversationId: "conv-child",
      timestamp: NOW,
    });

    getState().loadDetail({ subagentId: "sa-1", events: [] });

    expect(getState().byId["sa-1"]?.conversationId).toBe("conv-child");
  });
});

// ---------------------------------------------------------------------------
// reconcileFromDaemon
// ---------------------------------------------------------------------------

describe("reconcileFromDaemon", () => {
  it("does not call the route when the assistant predates it", async () => {
    reconcileSupported = false;
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    expect(subagentsReconcileGet).not.toHaveBeenCalled();
  });

  it("queries the reconcile route scoped to the parent conversation", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(reconcileRequests).toHaveLength(1);
    expect(reconcileRequests[0]).toMatchObject({
      path: { assistant_id: "assistant-1" },
      query: { parentConversationId: "conv-parent" },
    });
  });

  it("materializes a full entry from an enriched response", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "running",
          conversationId: "conv-child",
          label: "Audit defenses",
          objective: "Find the hole",
          isFork: true,
          parentToolUseId: "toolu_1",
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("Audit defenses");
    expect(entry?.objective).toBe("Find the hole");
    expect(entry?.status).toBe("running");
    expect(entry?.isFork).toBe(true);
    expect(entry?.conversationId).toBe("conv-child");
    expect(entry?.parentConversationId).toBe("conv-parent");
    expect(entry?.parentToolUseId).toBe("toolu_1");
    expect(getState().byToolUseId.get("toolu_1")).toBe("sa-1");
    expect(getState().orderedIds).toEqual(["sa-1"]);
  });

  it("refreshes a known entry's status and conversation ids", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      timestamp: NOW,
    });
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": { status: "completed", conversationId: "conv-child" },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.label).toBe("Agent");
    expect(entry?.conversationId).toBe("conv-child");
    expect(entry?.parentConversationId).toBe("conv-parent");
  });

  it("creates only a stub for an unknown id on a bare-status daemon", async () => {
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "running" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("");
    expect(entry?.objective).toBe("");
    expect(entry?.status).toBe("running");
    expect(entry?.parentConversationId).toBe("conv-parent");
    expect(entry?.hydrationPending).toBe(true);
  });

  // Absence is authoritative because the daemon's snapshot spans live,
  // rehydrated AND durably-recorded children, a run whose terminal metadata
  // the retention sweep evicted still reports its terminal status, so only a
  // subagent the daemon has no record of at all goes missing.
  it("settles an active entry the daemon no longer knows about", async () => {
    getState().spawnSubagent({
      subagentId: "sa-gone",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-gone"]?.status).toBe("interrupted");
  });

  it("settles an absent entry even when the snapshot carries swept siblings", async () => {
    for (const subagentId of ["sa-gone", "sa-swept"]) {
      getState().spawnSubagent({
        subagentId,
        label: "Agent",
        objective: "",
        status: "running",
        parentConversationId: "conv-parent",
        timestamp: NOW,
      });
    }
    // `sa-swept` is terminal in the daemon's durable rows only, its
    // in-memory metadata is long gone. It reports `completed`; `sa-gone` has
    // no row at all, so its absence is still the real thing.
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-swept": {
          status: "completed",
          conversationId: "conv-child-swept",
          label: "Swept",
          usage: { inputTokens: 90, outputTokens: 20, estimatedCost: 0.003 },
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-swept"]?.status).toBe("completed");
    expect(getState().byId["sa-swept"]?.inputTokens).toBe(90);
    expect(getState().byId["sa-gone"]?.status).toBe("interrupted");
  });

  it("never walks a settled entry back to an active status", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "completed",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    // A snapshot taken before the terminal event landed over SSE.
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "running" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]?.status).toBe("completed");
  });

  it("leaves an entry spawned after the request went out alone", async () => {
    reconcileReply = { ok: true, subagents: {} };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    getState().spawnSubagent({
      subagentId: "sa-late",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: Date.now(),
    });
    await pending;

    expect(getState().byId["sa-late"]?.status).toBe("running");
  });

  it("leaves an entry hydration materialized mid-flight alone", async () => {
    // A history page landing during the round-trip describes rows the daemon
    // was never asked about, so their absence from this response is not
    // evidence: the next pass, which does see them, decides.
    reconcileReply = { ok: true, subagents: {} };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    reconcileSubagentStoreFromNotifications(
      getState(),
      [{ subagentId: "sa-hydrated", label: "Agent", status: "running" }],
      "conv-parent",
      Date.now(),
    );
    await pending;

    expect(getState().byId["sa-hydrated"]?.status).toBe("running");
  });

  it("settles a hydrated row that was already present when the request went out", async () => {
    // Hydration stamps `spawnedAt` at hydration time, so a row it recovered
    // moments before the request looks younger than it: the old
    // `spawnedAt >= requestedAt` heuristic exempted exactly the stuck-`running`
    // rows this pass exists to settle.
    setSystemTime(new Date(NOW));
    reconcileSubagentStoreFromNotifications(
      getState(),
      [{ subagentId: "sa-hydrated", label: "Agent", status: "running" }],
      "conv-parent",
      Date.now(),
    );
    reconcileReply = { ok: true, subagents: {} };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-hydrated"]?.status).toBe("interrupted");
  });

  it("leaves a candidate that settled truthfully during the round-trip alone", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    // The terminal event the snapshot predates.
    getState().changeStatus({ subagentId: "sa-1", status: "completed" });
    await pending;

    expect(getState().byId["sa-1"]?.status).toBe("completed");
  });

  it("leaves an absent entry from another conversation untouched", async () => {
    getState().spawnSubagent({
      subagentId: "sa-other",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-other",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-other"]?.status).toBe("running");
  });

  it("leaves a terminal entry alone rather than re-settling it", async () => {
    getState().spawnSubagent({
      subagentId: "sa-done",
      label: "Agent",
      objective: "",
      status: "completed",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-done"]?.status).toBe("completed");
  });

  it("changes nothing on a non-ok response", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    const byIdBefore = getState().byId;
    reconcileReply = { ok: false };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId).toBe(byIdBefore);
    expect(getState().byId["sa-1"]?.status).toBe("running");
  });

  it("shares one request between concurrent calls for the same conversation", async () => {
    await Promise.all([
      getState().reconcileFromDaemon("assistant-1", "conv-parent"),
      getState().reconcileFromDaemon("assistant-1", "conv-parent"),
    ]);

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(1);
  });

  it("re-requests once the previous call has settled and the window reopens", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    advancePastReconcileWindow();
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(2);
  });

  it("throttles a settled trigger that re-fires inside the window", async () => {
    // An SSE flap: the reopen trigger fires again moments after the mount
    // pass finished, so single-flight has already let go.
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(1);
  });

  it("throttles each parent conversation on its own window", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    await getState().reconcileFromDaemon("assistant-1", "conv-other");

    expect(reconcileRequests).toHaveLength(2);
  });

  it("reopens the window on reset so the next conversation reconciles at once", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    getState().reset();
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(2);
  });

  it("issues a reopen-triggered reconcile inside the window", async () => {
    // The dropped stream may have straddled a terminal status, and a reconcile
    // skipped here is never retried, the row would stay `running` forever.
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    await getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen");

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(2);
  });

  it("still shares one request between concurrent reopens", async () => {
    await Promise.all([
      getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen"),
      getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen"),
    ]);

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(1);
  });

  it("lets a reopen take the window so the reconnect's load pass is a no-op", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen");
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(1);
  });

  it("keeps each parent's reopen on its own window", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen");
    await getState().reconcileFromDaemon("assistant-1", "conv-other");

    expect(reconcileRequests).toHaveLength(2);
  });

  it("does not settle a candidate re-parented mid-round-trip", async () => {
    // `ensureEntry` guesses the conversation on screen as parent, so a later
    // `subagent_event` can re-attribute the stub. This response describes the
    // conversation it asked about, not the one the row now belongs to.
    getState().spawnSubagent({
      subagentId: "sa-moved",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    getState().setParentConversationId("sa-moved", "conv-other");
    await pending;

    expect(getState().byId["sa-moved"]?.status).toBe("running");
  });

  it("records no kick diagnostic when the assistant predates the route", async () => {
    reconcileSupported = false;

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(reconcileKicks()).toHaveLength(0);
  });

  it("records one kick diagnostic per round-trip, tagged with its trigger", async () => {
    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    // Throttled and single-flighted calls issue nothing, so they record
    // nothing.
    await Promise.all([
      getState().reconcileFromDaemon("assistant-1", "conv-parent"),
      getState().reconcileFromDaemon("assistant-1", "conv-parent", "unknown_id"),
    ]);
    await getState().reconcileFromDaemon("assistant-1", "conv-parent", "reopen");

    expect(reconcileKicks().map((event) => event.details.trigger)).toEqual([
      "mount",
      "reopen",
    ]);
  });

  it("tags an unknown-id kick with its own trigger", async () => {
    await getState().reconcileFromDaemon(
      "assistant-1",
      "conv-parent",
      "unknown_id",
    );

    expect(reconcileKicks()).toEqual([
      { kind: "subagent_reconcile_kick", details: { trigger: "unknown_id" } },
    ]);
  });

  it("skips an item whose status is not a known subagent status", async () => {
    reconcileReply = {
      ok: true,
      subagents: { "sa-1": { status: "zombie", label: "Agent" } },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]).toBeUndefined();
  });

  it("does not settle a known entry whose reported status is unparseable", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "zombie" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]?.status).toBe("running");
  });

  it("updates a known entry from a bare-status daemon without touching its timeline", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    getState().receiveEvent({
      subagentId: "sa-1",
      event: {
        type: "assistant_text_delta",
        content: "hello",
      } as SubagentInnerEvent,
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "completed" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.label).toBe("Agent");
    expect(entry?.objective).toBe("Task");
    expect(entry?.events).toHaveLength(1);
    expect(entry?.hydrationPending).toBeUndefined();
  });

  it("restores terminal usage and error when the terminal event was lost", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    // A streamed timeline makes the detail auto-fetch refuse this entry, so
    // the snapshot is the only thing that can restore its final numbers.
    getState().receiveEvent({
      subagentId: "sa-1",
      event: {
        type: "assistant_text_delta",
        content: "hello",
      } as SubagentInnerEvent,
      timestamp: NOW,
    });
    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 100,
      outputTokens: 20,
      estimatedCost: 0.001,
    });
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "failed",
          error: "provider timed out",
          usage: {
            inputTokens: 1200,
            outputTokens: 340,
            estimatedCost: 0.021,
          },
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toBe("provider timed out");
    expect(entry?.inputTokens).toBe(1200);
    expect(entry?.outputTokens).toBe(340);
    expect(entry?.totalCost).toBe(0.021);
    expect(entry?.events).toHaveLength(1);
  });

  it("leaves existing tallies intact when the snapshot carries no usage", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "Task",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    getState().updateUsage({
      subagentId: "sa-1",
      inputTokens: 100,
      outputTokens: 20,
      estimatedCost: 0.001,
    });
    reconcileReply = {
      ok: true,
      subagents: { "sa-1": { status: "completed" } },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.outputTokens).toBe(20);
    expect(entry?.totalCost).toBe(0.001);
    expect(entry?.error).toBeUndefined();
  });

  it("stamps usage and error onto an entry materialized from the snapshot", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "failed",
          label: "Audit defenses",
          error: "provider timed out",
          usage: {
            inputTokens: 900,
            outputTokens: 120,
            estimatedCost: 0.014,
          },
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toBe("provider timed out");
    expect(entry?.inputTokens).toBe(900);
    expect(entry?.outputTokens).toBe(120);
    expect(entry?.totalCost).toBe(0.014);
  });

  it("discards a snapshot that lands after the store was reset", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": { status: "running", label: "Agent", objective: "Task" },
      },
    };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    // The user switched conversation (or assistant) mid-round-trip.
    getState().reset();
    await pending;

    expect(getState().byId["sa-1"]).toBeUndefined();
    expect(getState().orderedIds).toEqual([]);
  });

  it("does not settle orphans against a store reset mid-flight", async () => {
    getState().spawnSubagent({
      subagentId: "sa-old",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    reconcileReply = { ok: true, subagents: {} };

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    getState().reset();
    // A row the newly-active context spawned, absent from the stale snapshot.
    getState().spawnSubagent({
      subagentId: "sa-new",
      label: "Agent",
      objective: "",
      status: "running",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });
    await pending;

    expect(getState().byId["sa-new"]?.status).toBe("running");
  });

  it("survives a history hydration that lands mid-flight", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-silent": { status: "running", label: "Agent", objective: "Task" },
      },
    };

    // A settled entry already in the store, enough to make a reset-based
    // hydration bump the generation and throw the snapshot away.
    getState().spawnSubagent({
      subagentId: "sa-prior",
      label: "Prior",
      objective: "",
      status: "completed",
      parentConversationId: "conv-parent",
      timestamp: NOW,
    });

    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    // History for the SAME conversation arrives while the request is out.
    // Hydration is a pure upsert, it never resets, so it cannot invalidate
    // the snapshot that recovers a run history never heard about.
    reconcileSubagentStoreFromNotifications(
      getState(),
      [{ subagentId: "sa-history", label: "Historical", status: "completed" }],
      "conv-parent",
      NOW,
    );
    await pending;

    expect(getState().byId["sa-silent"]?.status).toBe("running");
    expect(getState().byId["sa-history"]?.status).toBe("completed");
    expect(getState().byId["sa-prior"]?.status).toBe("completed");
  });

  it("re-requests after a reset instead of joining the invalidated call", async () => {
    const pending = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    getState().reset();
    reconcileReply = {
      ok: true,
      subagents: { "sa-1": { status: "running", label: "Agent" } },
    };
    const next = getState().reconcileFromDaemon("assistant-1", "conv-parent");
    await Promise.all([pending, next]);

    expect(subagentsReconcileGet).toHaveBeenCalledTimes(2);
    expect(getState().byId["sa-1"]?.label).toBe("Agent");
  });
});

// ---------------------------------------------------------------------------
// reconcileFromDaemon: identity backfill onto placeholder rows
// ---------------------------------------------------------------------------

describe("reconcileFromDaemon identity backfill", () => {
  it("fills a blank stub's label, objective and spawn anchor", async () => {
    // The stub a `subagent_status_changed` for an unknown id leaves behind:
    // "known" to the store, but with nothing to render.
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      status: "running",
      parentConversationId: "conv-parent",
    });
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "running",
          label: "Audit defenses",
          objective: "Find the hole",
          parentToolUseId: "toolu_1",
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("Audit defenses");
    expect(entry?.objective).toBe("Find the hole");
    expect(entry?.parentToolUseId).toBe("toolu_1");
    expect(getState().byToolUseId.get("toolu_1")).toBe("sa-1");
  });

  it("never overwrites identity the spawn event already established", async () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "spawn label",
      objective: "spawn objective",
      timestamp: NOW,
      parentToolUseId: "toolu_spawn",
    });
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "running",
          label: "snapshot label",
          objective: "snapshot objective",
          parentToolUseId: "toolu_snapshot",
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("spawn label");
    expect(entry?.objective).toBe("spawn objective");
    expect(entry?.parentToolUseId).toBe("toolu_spawn");
    expect(getState().byToolUseId.get("toolu_snapshot")).toBeUndefined();
  });

  it("leaves the placeholders alone when the snapshot carries no identity", async () => {
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      status: "running",
      parentConversationId: "conv-parent",
    });
    const byToolUseIdBefore = getState().byToolUseId;
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "running" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    const entry = getState().byId["sa-1"];
    expect(entry?.label).toBe("");
    expect(entry?.objective).toBe("");
    expect(entry?.parentToolUseId).toBeUndefined();
    expect(getState().byToolUseId).toBe(byToolUseIdBefore);
  });
});

// ---------------------------------------------------------------------------
// reconcileFromDaemon: arming materialized rows against the live stream
// ---------------------------------------------------------------------------

describe("reconcileFromDaemon hydration arming", () => {
  const textEvent: SubagentInnerEvent = {
    type: "assistant_text_delta",
    text: "live suffix",
  };

  it("arms a still-running row so its detail replaces the live suffix", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "running",
          label: "Audit defenses",
          conversationId: "conv-child",
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");
    expect(getState().byId["sa-1"]?.hydrationPending).toBe(true);

    // An event that lands while the detail fetch is out. Appending it would
    // make `loadDetail` keep the one-event suffix over the full history.
    getState().receiveEvent({
      subagentId: "sa-1",
      event: textEvent,
      timestamp: NOW + 1,
    });
    expect(getState().byId["sa-1"]?.events).toEqual([]);

    getState().loadDetail({
      subagentId: "sa-1",
      events: [
        { id: "e1", type: "text", content: "full", timestamp: NOW },
        { id: "e2", type: "text", content: "history", timestamp: NOW + 1 },
      ],
    });

    expect(getState().byId["sa-1"]?.events).toHaveLength(2);
    expect(getState().byId["sa-1"]?.hydrationPending).toBe(false);
  });

  it("leaves a settled row un-armed: nothing races it and nothing fetches it", async () => {
    reconcileReply = {
      ok: true,
      subagents: {
        "sa-1": {
          status: "completed",
          label: "Audit defenses",
          conversationId: "conv-child",
        },
      },
    };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]?.hydrationPending).toBeUndefined();
  });

  it("leaves an unaddressable row un-armed on a pre-0.11.0 daemon", async () => {
    selfLookupSupported = false;
    reconcileReply = { ok: true, subagents: { "sa-1": { status: "running" } } };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]?.hydrationPending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureEntry: parent scoping falls back to the conversation on screen
// ---------------------------------------------------------------------------

describe("ensureEntry parent scoping", () => {
  it("scopes an id-less stub to the active conversation", () => {
    useConversationStore.getState().setActiveConversationId("conv-active");

    getState().ensureEntry({ subagentId: "sa-1", timestamp: NOW });

    expect(getState().byId["sa-1"]?.parentConversationId).toBe("conv-active");
  });

  it("prefers the parent id the evidence carried", () => {
    useConversationStore.getState().setActiveConversationId("conv-active");

    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      parentConversationId: "conv-background",
    });

    expect(getState().byId["sa-1"]?.parentConversationId).toBe(
      "conv-background",
    );
  });

  it("lets reconcile's orphan pass settle a stub it scoped", async () => {
    // Without the fallback the stub belongs to no conversation: the overlay
    // shows it in all of them and the per-parent orphan pass settles it in
    // none.
    useConversationStore.getState().setActiveConversationId("conv-parent");
    getState().ensureEntry({
      subagentId: "sa-1",
      timestamp: NOW,
      status: "running",
    });
    reconcileReply = { ok: true, subagents: {} };

    await getState().reconcileFromDaemon("assistant-1", "conv-parent");

    expect(getState().byId["sa-1"]?.status).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// attachParentMessage
// ---------------------------------------------------------------------------

describe("attachParentMessage", () => {
  it("anchors an unanchored entry and indexes it under the message", () => {
    // Everything reconcile recovers arrives with no parent message id, so
    // `byParent` has no bucket for it and the transcript can't place its card.
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      timestamp: NOW,
    });
    expect(getState().byParent.size).toBe(0);

    getState().attachParentMessage("sa-1", "msg-1");

    expect(getState().byId["sa-1"]?.parentMessageId).toBe("msg-1");
    expect(getState().byParent.get("msg-1")).toEqual([
      getState().byId["sa-1"]!,
    ]);
  });

  it("keeps the stable-id bucket pointing at the updated entry", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      timestamp: NOW,
      parentMessageStableId: "stable-1",
    });

    getState().attachParentMessage("sa-1", "msg-1");

    const entry = getState().byId["sa-1"]!;
    expect(getState().byParent.get("stable-1")).toEqual([entry]);
    expect(getState().byParent.get("msg-1")).toEqual([entry]);
  });

  it("sorts a message bucket by spawn time", () => {
    getState().spawnSubagent({
      subagentId: "sa-late",
      label: "Late",
      objective: "",
      timestamp: NOW + 10,
      parentMessageId: "msg-1",
    });
    getState().spawnSubagent({
      subagentId: "sa-early",
      label: "Early",
      objective: "",
      timestamp: NOW,
    });

    getState().attachParentMessage("sa-early", "msg-1");

    expect(
      getState().byParent.get("msg-1")?.map((e) => e.subagentId),
    ).toEqual(["sa-early", "sa-late"]);
  });

  it("is a no-op for an entry already anchored to a message", () => {
    getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Agent",
      objective: "",
      timestamp: NOW,
      parentMessageId: "msg-original",
    });
    const byParentBefore = getState().byParent;

    getState().attachParentMessage("sa-1", "msg-other");

    expect(getState().byId["sa-1"]?.parentMessageId).toBe("msg-original");
    expect(getState().byParent).toBe(byParentBefore);
  });

  it("is a no-op for an unknown subagent", () => {
    const byIdBefore = getState().byId;

    getState().attachParentMessage("sa-missing", "msg-1");

    expect(getState().byId).toBe(byIdBefore);
  });
});
