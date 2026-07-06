import { describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before any imports that transitively load these) ──

// Mock conversation-crud before importing tool executors that depend on it.
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

/**
 * Captured messages from injectMessageIntoParent → findConversation → enqueueMessage.
 * Each test can read this after triggering a notification.
 */
const capturedMessages: string[] = [];

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (_id: string) => ({
    enqueueMessage: (options: { content: string }) => {
      capturedMessages.push(options.content);
      return { queued: true };
    },
    persistUserMessage: async () => ({ id: "mock-msg", deduplicated: false }),
    runAgentLoop: async () => {},
  }),
}));

// notifyParentFromChild resolves the child → parent relation and lifecycle
// status from the durable subagent record, not the live manager — so tests
// seed records into this map rather than poking the manager's internals.
const records = new Map<string, SubagentRecord>();
mock.module("../persistence/subagent-store.js", () => ({
  getSubagentRecordByConversationId: (conversationId: string) =>
    records.get(conversationId),
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import type { SubagentRecord } from "../persistence/subagent-store.js";
import { notifyParentFromChild } from "../subagent/notify.js";
import {
  executeSubagentNotifyParent,
  notifyParentTool,
} from "../tools/subagent/notify-parent.js";

// ── Shared helpers ──────────────────────────────────────────────────

/**
 * Seed a durable subagent record so `notifyParentFromChild` (and the
 * `notify_parent` tool) resolve `conversationId` to a subagent. Defaults to a
 * running general subagent; pass overrides for status, label, fork, etc.
 */
function seedSubagent(
  conversationId: string,
  overrides: Partial<SubagentRecord> = {},
): void {
  records.set(conversationId, {
    id: `sub-${conversationId}`,
    parentConversationId: `parent-${conversationId}`,
    conversationId,
    label: "Test",
    objective: "test",
    role: "general",
    isFork: false,
    sendResultToUser: null,
    status: "running",
    error: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    ...overrides,
  });
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

/** Drain capturedMessages and return the latest one. */
function lastCapturedMessage(): string {
  return capturedMessages[capturedMessages.length - 1] ?? "";
}

function clearCaptured(): void {
  capturedMessages.length = 0;
}

// ── Tool definition ────────────────────────────────────────────────

describe("notify_parent tool definition", () => {
  test("has correct core tool definition", () => {
    const def = notifyParentTool;
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
    clearCaptured();
    const conversationId = "conv-notify-sub-1";
    seedSubagent(conversationId);

    const result = await executeSubagentNotifyParent(
      { message: "Found key results", urgency: "important" },
      makeContext(conversationId),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.sent).toBe(true);
    expect(parsed.urgency).toBe("important");
    expect(lastCapturedMessage()).toContain("Found key results");
  });

  test("formats message with label and urgency", async () => {
    clearCaptured();
    const conversationId = "conv-notify-format-1";
    seedSubagent(conversationId, {
      label: "Research Task",
      objective: "research",
    });

    await executeSubagentNotifyParent(
      { message: "Preliminary findings ready", urgency: "info" },
      makeContext(conversationId),
    );
    expect(lastCapturedMessage()).toBe(
      '[Subagent "Research Task" — info] Preliminary findings ready',
    );
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
    const conversationId = "conv-notify-default-urg-1";
    seedSubagent(conversationId);

    const result = await executeSubagentNotifyParent(
      { message: "Progress update" },
      makeContext(conversationId),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.urgency).toBe("info");
  });

  test("appends guidance hint for blocked urgency", async () => {
    clearCaptured();
    const conversationId = "conv-notify-blocked-1";
    seedSubagent(conversationId);

    await executeSubagentNotifyParent(
      { message: "Need API key to proceed", urgency: "blocked" },
      makeContext(conversationId),
    );
    expect(lastCapturedMessage()).toContain("Need API key to proceed");
    expect(lastCapturedMessage()).toContain(
      "Use subagent_message to send guidance to this subagent.",
    );
  });
});

// ── notifyParentFromChild ──────────────────────────────────────────

describe("notifyParentFromChild", () => {
  test("returns false when the conversation is not a subagent", () => {
    expect(notifyParentFromChild("unknown-conversation", "hi", "info")).toBe(
      false,
    );
  });

  test("returns false for terminal subagents", () => {
    for (const status of ["completed", "failed", "aborted"] as const) {
      const conversationId = `conv-terminal-${status}`;
      seedSubagent(conversationId, { status });
      expect(
        notifyParentFromChild(conversationId, "Should not arrive", "info"),
      ).toBe(false);
    }
  });

  test("returns true for a running subagent and injects into the parent", () => {
    clearCaptured();
    const conversationId = "conv-running-1";
    seedSubagent(conversationId);

    expect(notifyParentFromChild(conversationId, "Test message", "info")).toBe(
      true,
    );
    expect(lastCapturedMessage()).toContain("Test message");
  });

  test("labels forks as Fork", () => {
    clearCaptured();
    const conversationId = "conv-fork-1";
    seedSubagent(conversationId, { isFork: true, label: "Explore" });

    notifyParentFromChild(conversationId, "branch result", "info");
    expect(lastCapturedMessage()).toBe('[Fork "Explore" — info] branch result');
  });
});
