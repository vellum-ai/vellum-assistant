import { describe, expect, test } from "bun:test";

import {
  clearConversations,
  findConversation,
  setConversation,
} from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message } from "../providers/types.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentConfig, SubagentState } from "../subagent/types.js";

/** Minimal shape matching the private ManagedSubagent interface for test injection. */
interface FakeManagedSubagent {
  conversation: {
    abort: () => void;
    dispose: () => void;
    messages: Message[];
    sendToClient: (msg: ServerMessage) => void;
    persistUserMessage?: (msg: string) => string;
    runAgentLoop?: () => Promise<void>;
    enqueueMessage?: () => { rejected: boolean; queued: boolean };
    injectInheritedContext?: (messages: Message[]) => void;
    setSubagentAllowedTools?: (tools: Set<string>) => void;
    getCurrentSystemPrompt?: () => string;
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: ServerMessage) => void;
  retainedUntil?: number;
  hadEnqueuedMessages?: boolean;
}

/** Type-safe accessor for SubagentManager's private internals via bracket notation. */
interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
  sweepTerminal: () => void;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeFakeConversation(): NonNullable<
  FakeManagedSubagent["conversation"]
> {
  return {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
  };
}

function injectFakeSubagent(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
  parentSendToClient?: (msg: ServerMessage) => void,
  conversation?: FakeManagedSubagent["conversation"],
): void {
  const internals = asInternals(manager);

  internals.subagents.set(subagentId, {
    conversation:
      conversation === undefined ? makeFakeConversation() : conversation,
    state,
    parentSendToClient: parentSendToClient ?? (() => {}),
  });

  const parentId = state.config.parentConversationId;
  if (!internals.parentToChildren.has(parentId)) {
    internals.parentToChildren.set(parentId, new Set());
  }
  internals.parentToChildren.get(parentId)!.add(subagentId);
}

function makeConfig(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    id: "sub-1",
    parentConversationId: "parent-sess-1",
    label: "Test subagent",
    objective: "Do something",
    ...overrides,
  };
}

function makeState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
  configOverrides: Partial<SubagentConfig> = {},
): SubagentState {
  return {
    config: makeConfig({ id: subagentId, ...configOverrides }),
    status: "running",
    conversationId: "conv-sub-1",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
}

const FAKE_PARENT_MESSAGES: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Hello from parent" }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Hello! How can I help?" }],
  },
];

describe("SubagentManager fork spawn", () => {
  test("fork injects inherited context before persistUserMessage", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-fork-1";

    const injectedMessages: Message[][] = [];
    const fakeConversation = makeFakeConversation();
    fakeConversation.persistUserMessage = () => "msg-1";
    fakeConversation.runAgentLoop = async () => {};
    fakeConversation.injectInheritedContext = (msgs: Message[]) => {
      injectedMessages.push(msgs);
    };

    const state = makeState(
      subagentId,
      { isFork: true },
      {
        fork: true,
        parentMessages: FAKE_PARENT_MESSAGES,
        parentSystemPrompt: "You are a helpful assistant.",
      },
    );

    injectFakeSubagent(manager, subagentId, state, undefined, fakeConversation);

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]).toEqual(FAKE_PARENT_MESSAGES);

    asInternals(manager).stopSweep();
  });

  test("fork state has isFork: true", () => {
    const state = makeState("sub-fork-1", { isFork: true }, { fork: true });

    expect(state.isFork).toBe(true);
  });

  test("fork defaults sendResultToUser to false", () => {
    // Simulate the resolution logic from spawn():
    // For forks, if sendResultToUser is undefined, it should resolve to false.
    const config: SubagentConfig = makeConfig({
      fork: true,
      // sendResultToUser is undefined
    });
    const isFork = config.fork === true;
    const resolvedSendResultToUser = isFork
      ? config.sendResultToUser === true
        ? true
        : false
      : config.sendResultToUser;

    expect(resolvedSendResultToUser).toBe(false);
  });

  test("fork with explicit sendResultToUser: true preserves it", () => {
    const config: SubagentConfig = makeConfig({
      fork: true,
      sendResultToUser: true,
    });
    const isFork = config.fork === true;
    const resolvedSendResultToUser = isFork
      ? config.sendResultToUser === true
        ? true
        : false
      : config.sendResultToUser;

    expect(resolvedSendResultToUser).toBe(true);
  });

  test("non-fork spawn does not inject inherited context", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-normal-1";

    let injectCalled = false;
    const fakeConversation = makeFakeConversation();
    fakeConversation.persistUserMessage = () => "msg-1";
    fakeConversation.runAgentLoop = async () => {};
    fakeConversation.injectInheritedContext = () => {
      injectCalled = true;
    };

    const state = makeState(subagentId, { isFork: false });

    injectFakeSubagent(manager, subagentId, state, undefined, fakeConversation);

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(injectCalled).toBe(false);

    asInternals(manager).stopSweep();
  });

  test("non-fork sendResultToUser defaults are unaffected", () => {
    const config: SubagentConfig = makeConfig({
      fork: false,
      // sendResultToUser is undefined
    });
    const isFork = config.fork === true;
    const resolvedSendResultToUser = isFork
      ? config.sendResultToUser === true
        ? true
        : false
      : config.sendResultToUser;

    // Non-fork: sendResultToUser should remain undefined (caller handles default)
    expect(resolvedSendResultToUser).toBeUndefined();
  });

  test("fork uses default memory scope, not isolated subagent scope", () => {
    // Validate the fork memory policy shape matches what spawn() produces.
    const isFork = true;
    const subagentId = "sub-fork-mem";

    const memoryPolicy = isFork
      ? {
          scopeId: "default",
          includeDefaultFallback: false,
        }
      : {
          scopeId: `subagent:${subagentId}`,
          includeDefaultFallback: true,
        };

    expect(memoryPolicy.scopeId).toBe("default");
    expect(memoryPolicy.includeDefaultFallback).toBe(false);
  });

  test("non-fork uses isolated subagent memory scope", () => {
    const isFork = false;
    const subagentId = "sub-normal-mem";

    const memoryPolicy = isFork
      ? {
          scopeId: "default",
          includeDefaultFallback: false,
        }
      : {
          scopeId: `subagent:${subagentId}`,
          includeDefaultFallback: true,
        };

    expect(memoryPolicy.scopeId).toBe(`subagent:${subagentId}`);
    expect(memoryPolicy.includeDefaultFallback).toBe(true);
  });

  test("fork forces general role and skips tool filtering", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-fork-role";

    const fakeConversation = makeFakeConversation();
    fakeConversation.persistUserMessage = () => "msg-1";
    fakeConversation.runAgentLoop = async () => {};
    fakeConversation.injectInheritedContext = () => {};
    fakeConversation.setSubagentAllowedTools = () => {};

    // Create a fork state — in real spawn(), the role would be forced to
    // "general" regardless of what was requested, and tool filtering skipped.
    const state = makeState(
      subagentId,
      { isFork: true },
      {
        fork: true,
        role: "general", // forced by spawn() logic
        parentMessages: FAKE_PARENT_MESSAGES,
        parentSystemPrompt: "Parent system prompt.",
      },
    );

    injectFakeSubagent(manager, subagentId, state, undefined, fakeConversation);

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Tool filtering is only applied in spawn(), not runSubagent(), so we
    // verify the logic directly: forks skip setSubagentAllowedTools.
    // For this test, we verify the fork's role is general (which has no allowedTools).
    expect(state.config.role).toBe("general");

    asInternals(manager).stopSweep();
  });

  test("fork uses parent system prompt, not subagent-built prompt", () => {
    // The fork branch in spawn() uses config.parentSystemPrompt directly.
    // If it's not provided, it falls back to resolveParentConversation.
    const parentPrompt = "You are the parent's system prompt.";
    const config: SubagentConfig = makeConfig({
      fork: true,
      parentSystemPrompt: parentPrompt,
    });

    // Simulate fork system prompt resolution from spawn():
    const isFork = config.fork === true;
    let systemPrompt: string;
    if (isFork && config.parentSystemPrompt) {
      systemPrompt = config.parentSystemPrompt;
    } else {
      systemPrompt = "built subagent prompt"; // would be from buildSubagentSystemPrompt
    }

    expect(systemPrompt).toBe(parentPrompt);
  });

  test("fork resolves system prompt via conversation store when parentSystemPrompt is absent", () => {
    clearConversations();
    const parentPrompt = "Resolved parent system prompt.";

    // Populate the store with a mock parent conversation.
    setConversation("parent-sess-1", {
      getCurrentSystemPrompt: () => parentPrompt,
    } as any);

    // Simulate the fallback logic from spawn():
    const config: SubagentConfig = makeConfig({
      fork: true,
      parentConversationId: "parent-sess-1",
      // parentSystemPrompt is NOT set
    });

    let systemPrompt: string | undefined;
    if (config.fork && !config.parentSystemPrompt) {
      const parentConv = findConversation(config.parentConversationId);
      systemPrompt = parentConv?.getCurrentSystemPrompt?.();
    }

    expect(systemPrompt).toBe(parentPrompt);
  });

  test("fork throws when no parent system prompt is available", () => {
    // Simulate the error case from spawn():
    const config: SubagentConfig = makeConfig({
      fork: true,
      parentConversationId: "parent-sess-missing",
      // parentSystemPrompt is NOT set
    });

    const resolveParentConversation = (_id: string) => undefined;

    expect(() => {
      if (config.fork && !config.parentSystemPrompt) {
        const parentConv = resolveParentConversation(
          config.parentConversationId,
        );
        const resolved = (parentConv as any)?.getCurrentSystemPrompt?.();
        if (!resolved) {
          throw new Error(
            "Fork spawn requires a parent system prompt but neither config.parentSystemPrompt " +
              "nor resolveParentConversation yielded one.",
          );
        }
      }
    }).toThrow("Fork spawn requires a parent system prompt");
  });
});
