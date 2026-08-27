import { describe, expect, mock, test } from "bun:test";

// ── Module mocks ──────────────────────────────────────────────────

/**
 * Captured messages from injectMessageIntoParent → findConversation → enqueueMessage.
 * Each test clears this before use.
 */
const capturedNotifications: {
  parentConversationId: string;
  message: string;
}[] = [];

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => ({
    isStale: () => false,
    hasInFlightWork: () => false,
    enqueueMessage: (options: { content: string }) => {
      capturedNotifications.push({
        parentConversationId: id,
        message: options.content,
      });
      return { queued: true };
    },
    persistUserMessage: async () => ({ id: "mock-msg", deduplicated: false }),
    runAgentLoop: async () => {},
  }),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

import type { AssistantEvent } from "../api/index.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";

/** Minimal shape matching the private ManagedSubagent interface for test injection. */
interface FakeManagedSubagent {
  conversation: {
    abort: () => void;
    dispose: () => void;
    messages: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    sendToClient: (msg: AssistantEvent) => void;
    loadFromDb?: () => Promise<void>;
    persistUserMessage?: () => { id: string; deduplicated: boolean };
    runAgentLoop?: () => Promise<void>;
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
    subagentDeniedToolNames: Set<string>;
    subagentToolStats: {
      calls: number;
      succeeded: number;
      filesWritten: Set<string>;
    };
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: AssistantEvent) => void;
  /** Sticky marker that a follow-up turn was queued during the run. */
  hadEnqueuedMessages?: boolean;
}

/** Type-safe accessor for SubagentManager's private internals via bracket notation. */
interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
  releaseConversation: (managed: FakeManagedSubagent) => void;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

/**
 * Inject a fake managed subagent into the manager's private maps
 * so we can test abort/notification logic without needing a real Conversation.
 */
function injectFakeSubagent(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
  parentSendToClient?: (msg: AssistantEvent) => void,
): void {
  const fakeSession: FakeManagedSubagent["conversation"] = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
    subagentDeniedToolNames: new Set<string>(),
    subagentToolStats: {
      calls: 0,
      succeeded: 0,
      filesWritten: new Set<string>(),
    },
  };

  const internals = asInternals(manager);
  const subagents = internals.subagents;
  const parentToChildren = internals.parentToChildren;

  subagents.set(subagentId, {
    conversation: fakeSession,
    state,
    parentSendToClient: parentSendToClient ?? (() => {}),
  });

  const parentId = state.config.parentConversationId;
  if (!parentToChildren.has(parentId)) {
    parentToChildren.set(parentId, new Set());
  }
  parentToChildren.get(parentId)!.add(subagentId);
}

function makeState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
): SubagentState {
  return {
    config: {
      id: subagentId,
      parentConversationId: "parent-sess-1",
      label: "Test subagent",
      objective: "Do something",
    },
    status: "running",
    conversationId: "conv-sub-1",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
}

function clearCaptured(): void {
  capturedNotifications.length = 0;
}

describe("SubagentManager abort notification", () => {
  test("abort notifies parent with do-not-respawn message", () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const clientMessages: AssistantEvent[] = [];
    const sendToClient = (msg: AssistantEvent) => clientMessages.push(msg);

    const result = manager.abort(subagentId, sendToClient);

    expect(result).toBe(true);
    expect(state.status).toBe("aborted");
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0].message).toContain("explicitly aborted");
    expect(capturedNotifications[0].message).toContain("Do NOT re-spawn");
  });

  test("abort notification goes to parent conversation via findConversation", () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId); // parentConversationId = 'parent-sess-1'

    // The parent's stored sender (set at spawn time).
    const parentSender = () => {};
    injectFakeSubagent(manager, subagentId, state, parentSender);

    // A different sender (simulating abort from a different thread's socket).
    const abortingSender = ((_msg: AssistantEvent) => {}) as (
      msg: AssistantEvent,
    ) => void;

    manager.abort(subagentId, abortingSender);

    // Notification should be routed to the parent conversation via findConversation.
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0].parentConversationId).toBe("parent-sess-1");
  });

  test("abort sends subagent_status_changed to client", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";

    const clientMessages: AssistantEvent[] = [];
    const sendToClient = (msg: AssistantEvent) => clientMessages.push(msg);

    // Pass the sender as parentSendToClient so the stored sender receives the status update.
    injectFakeSubagent(
      manager,
      subagentId,
      makeState(subagentId),
      sendToClient,
    );

    manager.abort(subagentId, sendToClient);

    const statusMsg = clientMessages.find(
      (m) => m.type === "subagent_status_changed",
    );
    expect(statusMsg).toBeDefined();
    expect((statusMsg as unknown as Record<string, unknown>).subagentId).toBe(
      subagentId,
    );
    expect((statusMsg as unknown as Record<string, unknown>).status).toBe(
      "aborted",
    );
  });

  test("abort returns false for unknown subagent", () => {
    const manager = new SubagentManager();
    const result = manager.abort("nonexistent");
    expect(result).toBe(false);
  });

  test("abort returns false for already-terminal subagent", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    injectFakeSubagent(
      manager,
      subagentId,
      makeState(subagentId, { status: "completed" }),
    );

    const result = manager.abort(subagentId, () => {});
    expect(result).toBe(false);
  });

  test("abort without sendToClient sets status but does not notify", () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const result = manager.abort(subagentId);

    expect(result).toBe(true);
    expect(state.status).toBe("aborted");
    // Without parentSendToClient, abort skips both the status update and notification.
    expect(capturedNotifications).toHaveLength(0);
  });

  test("abort rejects when callerConversationId does not match parent", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId); // parentConversationId = 'parent-sess-1'
    injectFakeSubagent(manager, subagentId, state);

    const result = manager.abort(subagentId, () => {}, "different-session");

    expect(result).toBe(false);
    expect(state.status).toBe("running"); // unchanged
  });

  test("abort succeeds when callerConversationId matches parent", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const result = manager.abort(subagentId, () => {}, "parent-sess-1");

    expect(result).toBe(true);
    expect(state.status).toBe("aborted");
  });

  test("abort succeeds without callerConversationId (no ownership check)", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    // No callerConversationId — internal calls (eviction, abortAllForParent) skip ownership check
    const result = manager.abort(subagentId, () => {});

    expect(result).toBe(true);
    expect(state.status).toBe("aborted");
  });

  test("abort with suppressNotification skips parent notification", () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const result = manager.abort(subagentId, () => {}, undefined, {
      suppressNotification: true,
    });

    expect(result).toBe(true);
    expect(state.status).toBe("aborted");
    expect(capturedNotifications).toHaveLength(0);
  });
});

describe("SubagentManager notifyParent (via runSubagent)", () => {
  test("completed subagent notifies parent to use subagent_read", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    // Patch the fake conversation to simulate a successful agent loop.
    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("completed");
    expect(state.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.005,
    });
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0].parentConversationId).toBe("parent-sess-1");
    expect(capturedNotifications[0].message).toContain(
      '[Subagent "Test subagent" completed]',
    );
    expect(capturedNotifications[0].message).toContain("subagent_read");

    asInternals(manager).stopSweep();
  });

  test("failed subagent notifies parent with error and asks user before retry", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    // Patch the fake conversation to simulate a failure.
    const managed = asInternals(manager).subagents.get(subagentId)!;

    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("API rate limit exceeded");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("failed");
    expect(state.error).toBe("API rate limit exceeded");
    expect(state.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.005,
    });
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0].message).toContain("failed");
    expect(capturedNotifications[0].message).toContain(
      "API rate limit exceeded",
    );
    expect(capturedNotifications[0].message).toContain("Do NOT re-spawn");

    asInternals(manager).stopSweep();
  });

  test("a settled run's notification carries what it actually ran", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-stats";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      const counters = managed.conversation!.subagentToolStats;
      counters.calls += 2;
      counters.succeeded += 2;
      counters.filesWritten.add("/report.md");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(capturedNotifications[0].message).toContain(
      "[stats: 2 tool calls, 2 succeeded, files written via file_write/file_edit: 1]",
    );

    asInternals(manager).stopSweep();
  });

  test("a queued follow-up turn's tool calls reach the reported stats", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-queued-stats";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      const counters = managed.conversation!.subagentToolStats;
      counters.calls += 2;
      counters.succeeded += 2;
    };
    // Guidance arrived while the run was processing: the conversation is
    // retained past the run so it can drain that turn afterwards.
    managed.hadEnqueuedMessages = true;

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // The run's own harvest only ever sees its own calls.
    expect(state.stats).toEqual({ calls: 2, succeeded: 2, filesWritten: 0 });
    // Quoting it in a message that is never rewritten would under-report the
    // queued turn permanently, so the deferred notification quotes nothing and
    // sends the parent to subagent_read instead.
    expect(capturedNotifications[0].message).toContain(
      "Queued follow-up guidance is still being processed",
    );
    expect(capturedNotifications[0].message).not.toContain("[stats:");

    // The queued turn now drains, into the same retained conversation.
    const counters = managed.conversation!.subagentToolStats;
    counters.calls += 3;
    counters.succeeded += 2;
    counters.filesWritten.add("/queued-turn.md");

    expect(manager.currentToolStats(subagentId)).toEqual({
      kind: "counted",
      stats: { calls: 5, succeeded: 4, filesWritten: 1 },
    });

    asInternals(manager).stopSweep();
  });

  test("releasing the conversation freezes the settled counters", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-release-stats";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      managed.conversation!.subagentToolStats.calls += 1;
      managed.conversation!.subagentToolStats.succeeded += 1;
    };
    managed.hadEnqueuedMessages = true;

    await asInternals(manager).runSubagent(subagentId, "Do something");

    const counters = managed.conversation!.subagentToolStats;
    counters.calls += 4;
    counters.succeeded += 3;

    // The sweep releases the retained conversation once the drain has had its
    // window; the last reading is taken on the way out and stands afterwards.
    asInternals(manager).releaseConversation(managed);

    expect(managed.conversation).toBeNull();
    expect(manager.currentToolStats(subagentId)).toEqual({
      kind: "counted",
      stats: { calls: 5, succeeded: 4, filesWritten: 0 },
    });

    asInternals(manager).stopSweep();
  });

  test("a run that never harvested reports nothing rather than a zero", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-unharvested";
    injectFakeSubagent(manager, subagentId, makeState(subagentId));

    // Still running: its counters are mid-flight, and a zero read off them now
    // would read as "this subagent used no tools".
    expect(manager.currentToolStats(subagentId)).toEqual({
      kind: "unmeasured",
    });
  });

  test("an id the manager never held reports its counters unrecoverable", () => {
    const manager = new SubagentManager();

    // The counters exist nowhere but memory, so a caller holding a
    // record-derived state for this id can never get them, and reporting zero
    // calls would read as "this subagent did nothing".
    expect(manager.currentToolStats("sub-not-in-manager")).toEqual({
      kind: "unrecoverable",
    });
  });

  test("failed subagent does not notify if already aborted", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId, { status: "aborted" });
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;

    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Conversation aborted");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Should NOT notify — status was already terminal (aborted).
    expect(capturedNotifications).toHaveLength(0);

    asInternals(manager).stopSweep();
  });
});

describe("SubagentManager hasActiveChildren", () => {
  test("is true for pending, running, and awaiting_input children", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-running",
      makeState("sub-running", { status: "running" }),
    );

    expect(manager.hasActiveChildren("parent-sess-1")).toBe(true);

    asInternals(manager).subagents.get("sub-running")!.state.status =
      "awaiting_input";
    expect(manager.hasActiveChildren("parent-sess-1")).toBe(true);

    asInternals(manager).subagents.get("sub-running")!.state.status = "pending";
    expect(manager.hasActiveChildren("parent-sess-1")).toBe(true);
  });

  test("is false when every child is terminal or the parent has none", () => {
    const manager = new SubagentManager();
    expect(manager.hasActiveChildren("parent-sess-1")).toBe(false);

    injectFakeSubagent(
      manager,
      "sub-done",
      makeState("sub-done", { status: "completed" }),
    );
    injectFakeSubagent(
      manager,
      "sub-aborted",
      makeState("sub-aborted", { status: "aborted" }),
    );

    expect(manager.hasActiveChildren("parent-sess-1")).toBe(false);
  });
});

describe("SubagentManager abortAllForParent", () => {
  test("aborts active children but keeps every child's state readable", () => {
    clearCaptured();
    const manager = new SubagentManager();
    injectFakeSubagent(manager, "sub-1", makeState("sub-1"));
    injectFakeSubagent(manager, "sub-2", makeState("sub-2"));
    injectFakeSubagent(
      manager,
      "sub-3",
      makeState("sub-3", { status: "completed" }),
    );

    const count = manager.abortAllForParent("parent-sess-1", () => {});

    expect(count).toBe(2); // sub-1 and sub-2, not sub-3 (already completed)
    expect(capturedNotifications).toHaveLength(2);

    // The parent conversation lives on (stop/eviction/rebuild), so every
    // child stays tracked: aborted ones as terminal metadata, and the
    // completed one still readable via subagent_read.
    expect(manager.getState("sub-1")?.status).toBe("aborted");
    expect(manager.getState("sub-2")?.status).toBe("aborted");
    expect(manager.getState("sub-3")?.status).toBe("completed");
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(3);
  });

  test("returns 0 for unknown parent", () => {
    const manager = new SubagentManager();
    const count = manager.abortAllForParent("nonexistent");
    expect(count).toBe(0);
  });
});

describe("SubagentManager disposeAllForParent", () => {
  test("aborts and removes all children — parent data is going away", () => {
    clearCaptured();
    const manager = new SubagentManager();
    injectFakeSubagent(manager, "sub-1", makeState("sub-1"));
    injectFakeSubagent(
      manager,
      "sub-2",
      makeState("sub-2", { status: "completed" }),
    );

    const count = manager.disposeAllForParent("parent-sess-1", () => {});

    expect(count).toBe(1); // only sub-1 was still in flight
    expect(manager.getState("sub-1")).toBeUndefined();
    expect(manager.getState("sub-2")).toBeUndefined();
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(0);
  });

  test("returns 0 for unknown parent", () => {
    const manager = new SubagentManager();
    const count = manager.disposeAllForParent("nonexistent");
    expect(count).toBe(0);
  });
});

describe("SubagentManager disposeAllForAllParents", () => {
  test("removes retained children across every parent — clear-all semantics", () => {
    clearCaptured();
    const manager = new SubagentManager();
    // Two parents; only one would appear in the in-memory conversation store
    // during a clear-all — the other models an evicted parent whose terminal
    // children are still retained.
    injectFakeSubagent(manager, "sub-a", makeState("sub-a"));
    injectFakeSubagent(
      manager,
      "sub-b",
      makeState("sub-b", {
        config: {
          id: "sub-b",
          parentConversationId: "parent-evicted",
          label: "Evicted parent child",
          objective: "Do something",
        },
        status: "completed",
      }),
    );

    manager.disposeAllForAllParents();

    expect(manager.getState("sub-a")).toBeUndefined();
    expect(manager.getState("sub-b")).toBeUndefined();
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(0);
    expect(manager.getChildrenOf("parent-evicted")).toHaveLength(0);
  });
});

describe("SubagentManager sharedRequestTimestamps", () => {
  test("defaults to an empty array", () => {
    const manager = new SubagentManager();
    expect(manager.sharedRequestTimestamps).toEqual([]);
  });

  test("uses the assigned shared array (not a copy)", () => {
    const manager = new SubagentManager();
    const shared: number[] = [100, 200, 300];
    manager.sharedRequestTimestamps = shared;

    // Should be the same reference, so mutations are shared globally.
    expect(manager.sharedRequestTimestamps).toBe(shared);
    shared.push(400);
    expect(manager.sharedRequestTimestamps).toHaveLength(4);
  });
});

describe("SubagentManager abort race guard", () => {
  test("completed subagent does not notify if already aborted", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId, { status: "aborted" });
    injectFakeSubagent(manager, subagentId, state);

    // Patch conversation to simulate successful completion after abort.
    const managed = asInternals(manager).subagents.get(subagentId)!;

    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};
    managed.conversation!.messages = [
      { role: "assistant", content: [{ type: "text", text: "Done!" }] },
    ];

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Should NOT notify — status was already terminal (aborted) when loop finished.
    expect(capturedNotifications).toHaveLength(0);
    // Status should remain aborted, not overwritten to completed.
    expect(state.status).toBe("aborted");

    asInternals(manager).stopSweep();
  });
});

describe("SubagentManager sendMessage validation", () => {
  test("rejects empty content without throwing", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    injectFakeSubagent(manager, subagentId, makeState(subagentId));

    expect(await manager.sendMessage(subagentId, "")).toBe("empty");
    expect(await manager.sendMessage(subagentId, "   ")).toBe("empty");
    expect(await manager.sendMessage(subagentId, "\n\t")).toBe("empty");
  });
});
