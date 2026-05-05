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

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: (id: string) => ({
    enqueueMessage: (content: string) => {
      capturedNotifications.push({
        parentConversationId: id,
        message: content,
      });
      return { queued: true };
    },
    persistUserMessage: async () => "mock-msg",
    runAgentLoop: async () => {},
  }),
  addConversation: () => {},
  removeConversation: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
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
    sendToClient: (msg: ServerMessage) => void;
    loadFromDb?: () => Promise<void>;
    persistUserMessage?: (msg: string) => string;
    runAgentLoop?: () => Promise<void>;
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: ServerMessage) => void;
}

/** Type-safe accessor for SubagentManager's private internals via bracket notation. */
interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
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
  parentSendToClient?: (msg: ServerMessage) => void,
): void {
  const fakeSession: FakeManagedSubagent["conversation"] = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
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

    const clientMessages: ServerMessage[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

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
    const abortingSender = ((_msg: ServerMessage) => {}) as (
      msg: ServerMessage,
    ) => void;

    manager.abort(subagentId, abortingSender);

    // Notification should be routed to the parent conversation via findConversation.
    expect(capturedNotifications).toHaveLength(1);
    expect(capturedNotifications[0].parentConversationId).toBe("parent-sess-1");
  });

  test("abort sends subagent_status_changed to client", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";

    const clientMessages: ServerMessage[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

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
    managed.conversation!.persistUserMessage = () => "msg-1";
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

    managed.conversation!.persistUserMessage = () => "msg-1";
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

  test("failed subagent does not notify if already aborted", async () => {
    clearCaptured();
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId, { status: "aborted" });
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;

    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Conversation aborted");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Should NOT notify — status was already terminal (aborted).
    expect(capturedNotifications).toHaveLength(0);

    asInternals(manager).stopSweep();
  });
});

describe("SubagentManager abortAllForParent", () => {
  test("aborts all active children of a parent", () => {
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

    // All children should be disposed — parent is going away.
    expect(manager.getState("sub-1")).toBeUndefined();
    expect(manager.getState("sub-2")).toBeUndefined();
    expect(manager.getState("sub-3")).toBeUndefined();
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(0);
  });

  test("returns 0 for unknown parent", () => {
    const manager = new SubagentManager();
    const count = manager.abortAllForParent("nonexistent");
    expect(count).toBe(0);
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

    managed.conversation!.persistUserMessage = () => "msg-1";
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
