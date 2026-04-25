import { describe, expect, mock, test } from "bun:test";

// Mock conversation-crud before importing tool executors that depend on it.
mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => null,
  createConversation: () => ({ id: "mock-conv" }),
}));

import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import { getSubagentManager } from "../subagent/index.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";
import {
  executeSubagentNotifyParent,
  notifyParentTool,
} from "../tools/subagent/notify-parent.js";

// ── Shared helpers ──────────────────────────────────────────────────

/**
 * Inject a fake subagent into the singleton manager so tool executors
 * can find it. Uses the same private-internals trick as the other tests.
 */
function injectSubagent(
  manager: SubagentManager,
  subagentId: string,
  parentConversationId: string,
  status: SubagentState["status"] = "running",
  overrides: Partial<SubagentState> = {},
): SubagentState {
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: unknown;
        state: SubagentState;
        parentSendToClient: () => void;
      }
    >;
    parentToChildren: Map<string, Set<string>>;
  };
  const state: SubagentState = {
    config: {
      id: subagentId,
      parentConversationId,
      label: "Test",
      objective: "test",
    },
    status,
    conversationId: `conv-${subagentId}`,
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
  const fakeConversation = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    enqueueMessage: () => ({ queued: false }),
    persistUserMessage: () => "msg-1",
    runAgentLoop: async () => {},
  };
  internals.subagents.set(subagentId, {
    conversation: fakeConversation,
    state,
    parentSendToClient: () => {},
  });
  if (!internals.parentToChildren.has(parentConversationId)) {
    internals.parentToChildren.set(parentConversationId, new Set());
  }
  internals.parentToChildren.get(parentConversationId)!.add(subagentId);
  return state;
}

function makeContext(
  conversationId: string,
  extras: Record<string, unknown> = {},
) {
  return {
    workingDir: "/tmp",
    conversationId,
    trustClass: "guardian" as const,
    ...extras,
  } as import("../tools/types.js").ToolContext;
}

// ── Tool definition ────────────────────────────────────────────────

describe("notify_parent tool definition", () => {
  test("has correct core tool definition", () => {
    const def = notifyParentTool.getDefinition();
    const schema = def.input_schema as Record<string, unknown>;
    expect(def.name).toBe("notify_parent");
    expect(schema.required).toContain("message");
    expect(
      (schema.properties as Record<string, Record<string, unknown>>).urgency
        .enum,
    ).toEqual(["info", "important", "blocked"]);
    expect(notifyParentTool.category).toBe("orchestration");
  });

  test("is hidden from non-subagent context", () => {
    const ctx = {
      isSubagent: false,
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      coreToolNames: new Set<string>(),
      toolsDisabledDepth: 0,
    } as unknown as import("../daemon/conversation-tool-setup.js").SkillProjectionContext;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(false);
  });

  test("is hidden when isSubagent is undefined", () => {
    const ctx = {
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      coreToolNames: new Set<string>(),
      toolsDisabledDepth: 0,
    } as unknown as import("../daemon/conversation-tool-setup.js").SkillProjectionContext;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(false);
  });

  test("is visible to subagent context", () => {
    const ctx = {
      isSubagent: true,
      preactivatedSkillIds: [],
      skillProjectionState: new Map(),
      skillProjectionCache: new Map(),
      coreToolNames: new Set<string>(),
      toolsDisabledDepth: 0,
    } as unknown as import("../daemon/conversation-tool-setup.js").SkillProjectionContext;
    expect(isToolActiveForContext("notify_parent", ctx)).toBe(true);
  });
});

// ── executeSubagentNotifyParent ────────────────────────────────────

describe("executeSubagentNotifyParent", () => {
  test("rejects calls from non-subagent conversations", async () => {
    const result = await executeSubagentNotifyParent(
      { message: "Found something important" },
      makeContext("not-a-subagent-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not notify parent");
    expect(result.content).toContain("only available to subagents");
  });

  test("succeeds when called from a subagent conversation", async () => {
    const manager = getSubagentManager();
    const subagentId = "notify-sub-1";
    const parentConversationId = "notify-parent-1";
    injectSubagent(manager, subagentId, parentConversationId, "running");

    // Wire up the onSubagentFinished callback.
    let capturedMessage = "";
    manager.onSubagentFinished = (_parentId: string, message: string) => {
      capturedMessage = message;
    };

    try {
      const result = await executeSubagentNotifyParent(
        { message: "Found key results", urgency: "important" },
        makeContext(`conv-${subagentId}`),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.sent).toBe(true);
      expect(parsed.urgency).toBe("important");
      expect(capturedMessage).toContain("Found key results");
    } finally {
      manager.onSubagentFinished = undefined;
    }
  });

  test("formats message with label and urgency", async () => {
    const manager = getSubagentManager();
    const subagentId = "notify-format-1";
    const parentConversationId = "notify-format-parent";
    injectSubagent(manager, subagentId, parentConversationId, "running", {
      config: {
        id: subagentId,
        parentConversationId,
        label: "Research Task",
        objective: "research",
      },
    });

    let capturedMessage = "";
    manager.onSubagentFinished = (_parentId: string, message: string) => {
      capturedMessage = message;
    };

    try {
      await executeSubagentNotifyParent(
        { message: "Preliminary findings ready", urgency: "info" },
        makeContext(`conv-${subagentId}`),
      );
      expect(capturedMessage).toBe(
        '[Subagent "Research Task" — info] Preliminary findings ready',
      );
    } finally {
      manager.onSubagentFinished = undefined;
    }
  });

  test("returns error when message is empty", async () => {
    const result = await executeSubagentNotifyParent(
      { message: "" },
      makeContext("some-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"message" is required');
  });

  test("returns error when message is missing", async () => {
    const result = await executeSubagentNotifyParent(
      {},
      makeContext("some-conv"),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"message" is required');
  });

  test("defaults urgency to info when not provided", async () => {
    const manager = getSubagentManager();
    const subagentId = "notify-default-urg-1";
    const parentConversationId = "notify-default-urg-parent";
    injectSubagent(manager, subagentId, parentConversationId, "running");

    manager.onSubagentFinished = () => {};

    try {
      const result = await executeSubagentNotifyParent(
        { message: "Progress update" },
        makeContext(`conv-${subagentId}`),
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content);
      expect(parsed.urgency).toBe("info");
    } finally {
      manager.onSubagentFinished = undefined;
    }
  });

  test("appends guidance hint for blocked urgency", async () => {
    const manager = getSubagentManager();
    const subagentId = "notify-blocked-1";
    const parentConversationId = "notify-blocked-parent";
    injectSubagent(manager, subagentId, parentConversationId, "running");

    let capturedMessage = "";
    manager.onSubagentFinished = (_parentId: string, message: string) => {
      capturedMessage = message;
    };

    try {
      await executeSubagentNotifyParent(
        { message: "Need API key to proceed", urgency: "blocked" },
        makeContext(`conv-${subagentId}`),
      );
      expect(capturedMessage).toContain("Need API key to proceed");
      expect(capturedMessage).toContain(
        "Use subagent_message to send guidance to this subagent.",
      );
    } finally {
      manager.onSubagentFinished = undefined;
    }
  });
});

// ── Manager-level tests ────────────────────────────────────────────

describe("SubagentManager.notifyParent", () => {
  test("returns false for terminal subagents", () => {
    const manager = getSubagentManager();

    for (const terminalStatus of ["completed", "failed", "aborted"] as const) {
      const subagentId = `notify-terminal-${terminalStatus}`;
      const parentConversationId = `notify-terminal-parent-${terminalStatus}`;
      injectSubagent(manager, subagentId, parentConversationId, terminalStatus);

      manager.onSubagentFinished = () => {};

      try {
        const result = manager.notifyParent(
          `conv-${subagentId}`,
          "Should not arrive",
          "info",
        );
        expect(result).toBe(false);
      } finally {
        manager.onSubagentFinished = undefined;
      }
    }
  });

  test("returns false when onSubagentFinished is not wired", () => {
    const manager = getSubagentManager();
    const subagentId = "notify-no-callback-1";
    const parentConversationId = "notify-no-callback-parent";
    injectSubagent(manager, subagentId, parentConversationId, "running");

    manager.onSubagentFinished = undefined;

    const result = manager.notifyParent(
      `conv-${subagentId}`,
      "Test message",
      "info",
    );
    expect(result).toBe(false);
  });
});

describe("SubagentManager.getParentInfo", () => {
  test("returns undefined for unknown conversationIds", () => {
    const manager = getSubagentManager();
    const result = manager.getParentInfo("nonexistent-conversation-id");
    expect(result).toBeUndefined();
  });

  test("returns parent info for known subagent conversationId", () => {
    const manager = getSubagentManager();
    const subagentId = "parent-info-sub-1";
    const parentConversationId = "parent-info-parent-1";
    injectSubagent(manager, subagentId, parentConversationId, "running", {
      config: {
        id: subagentId,
        parentConversationId,
        label: "Info Lookup",
        objective: "look things up",
      },
    });

    const info = manager.getParentInfo(`conv-${subagentId}`);
    expect(info).toBeDefined();
    expect(info!.parentConversationId).toBe(parentConversationId);
    expect(info!.subagentId).toBe(subagentId);
    expect(info!.label).toBe("Info Lookup");
    expect(typeof info!.parentSendToClient).toBe("function");
  });
});
