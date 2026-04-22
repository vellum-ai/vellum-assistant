import { describe, expect, test } from "bun:test";

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

function makeForkState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
): SubagentState {
  return makeState(subagentId, {
    isFork: true,
    config: {
      id: subagentId,
      parentConversationId: "parent-sess-1",
      label: "Analysis fork",
      objective: "Analyze data",
      fork: true,
      sendResultToUser: false,
    },
    ...overrides,
  });
}

describe("Fork completion notifications", () => {
  test("fork completion notification includes last_n: 1 guidance", async () => {
    const manager = new SubagentManager();
    const subagentId = "fork-1";
    const state = makeForkState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {};

    const notifications: { parentConversationId: string; message: string }[] =
      [];
    manager.onSubagentFinished = (parentConversationId, message) => {
      notifications.push({ parentConversationId, message });
    };

    await asInternals(manager).runSubagent(subagentId, "Analyze data");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("last_n: 1");

    asInternals(manager).stopSweep();
  });

  test("fork completion notification includes internal-processing instruction", async () => {
    const manager = new SubagentManager();
    const subagentId = "fork-1";
    const state = makeForkState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {};

    const notifications: { parentConversationId: string; message: string }[] =
      [];
    manager.onSubagentFinished = (parentConversationId, message) => {
      notifications.push({ parentConversationId, message });
    };

    await asInternals(manager).runSubagent(subagentId, "Analyze data");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain(
      "do NOT share raw fork output with the user",
    );
    expect(notifications[0].message).toContain(
      '[Fork "Analysis fork" completed]',
    );

    asInternals(manager).stopSweep();
  });

  test("fork failure notification uses [Fork prefix", async () => {
    const manager = new SubagentManager();
    const subagentId = "fork-1";
    const state = makeForkState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Context too large");
    };

    const notifications: { parentConversationId: string; message: string }[] =
      [];
    manager.onSubagentFinished = (parentConversationId, message) => {
      notifications.push({ parentConversationId, message });
    };

    await asInternals(manager).runSubagent(subagentId, "Analyze data");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain('[Fork "Analysis fork" failed]');
    expect(notifications[0].message).toContain("Context too large");
    expect(notifications[0].message).not.toContain("[Subagent");

    asInternals(manager).stopSweep();
  });
});

describe("Status response includes isFork", () => {
  test("getState includes isFork for fork sub-agents", () => {
    const manager = new SubagentManager();
    const subagentId = "fork-1";
    const state = makeForkState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const retrieved = manager.getState(subagentId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.isFork).toBe(true);
  });

  test("getState includes isFork: false for regular sub-agents", () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const retrieved = manager.getState(subagentId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.isFork).toBe(false);
  });

  test("getChildrenOf includes isFork in each child state", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(manager, "sub-1", makeState("sub-1"));
    injectFakeSubagent(manager, "fork-1", makeForkState("fork-1"));

    const children = manager.getChildrenOf("parent-sess-1");
    expect(children).toHaveLength(2);

    const regular = children.find((c) => c.config.id === "sub-1");
    const fork = children.find((c) => c.config.id === "fork-1");
    expect(regular!.isFork).toBe(false);
    expect(fork!.isFork).toBe(true);
  });
});

describe("Regular sub-agent notifications are unchanged", () => {
  test("regular completed subagent uses [Subagent prefix", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {};

    const notifications: { parentConversationId: string; message: string }[] =
      [];
    manager.onSubagentFinished = (parentConversationId, message) => {
      notifications.push({ parentConversationId, message });
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain(
      '[Subagent "Test subagent" completed]',
    );
    expect(notifications[0].message).not.toContain("[Fork");
    expect(notifications[0].message).not.toContain("last_n: 1");

    asInternals(manager).stopSweep();
  });

  test("regular failed subagent uses [Subagent prefix", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => "msg-1";
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Something went wrong");
    };

    const notifications: { parentConversationId: string; message: string }[] =
      [];
    manager.onSubagentFinished = (parentConversationId, message) => {
      notifications.push({ parentConversationId, message });
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain(
      '[Subagent "Test subagent" failed]',
    );
    expect(notifications[0].message).not.toContain("[Fork");

    asInternals(manager).stopSweep();
  });
});
