import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { getConversationDirName } from "../memory/conversation-disk-view.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock dependencies — follows conversation-profile-injection.test.ts pattern
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      enabled: true,
      maxInputTokens: 100000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: { enabled: false },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
  loadSkillBySelector: () => ({ skill: null }),
  ensureSkillIcon: async () => null,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    createdAt: Date.parse("2026-03-19T12:00:00.000Z"),
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: () => ({ id: "msg-1" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], deletedSummaryIds: [] }),
  deleteLastExchange: () => 0,
}));

mock.module("../memory/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: "att-1" }),
  linkAttachmentToMessage: () => {},
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => null,
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

mock.module("../memory/query-builder.js", () => ({
  buildMemoryQuery: () => "",
}));

mock.module("../memory/retrieval-budget.js", () => ({
  computeRecallBudget: () => 0,
}));

mock.module("../context/window-manager.js", () => ({
  ContextWindowManager: class {
    constructor() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "usage-1", createdAt: Date.now() }),
}));

mock.module("../memory/app-store.js", () => ({
  getApp: () => null,
  updateApp: () => {},
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    getActiveModel() {
      return undefined;
    }
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
    ): Promise<Message[]> {
      const assistantMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      };
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 10,
      });
      onEvent({ type: "message_complete", message: assistantMessage });
      return [...messages, assistantMessage];
    }
  },
}));

import { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(workingDir = "/tmp"): Conversation {
  const provider = {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  return new Conversation(
    "conv-1",
    provider,
    "system prompt",
    4096,
    () => {},
    workingDir,
  );
}

const conversationDirName = getConversationDirName(
  "conv-1",
  Date.parse("2026-03-19T12:00:00.000Z"),
);
const conversationPath = `conversations/${conversationDirName}/`;
const conversationAttachmentsPath = `${conversationPath}attachments/`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation workspace cache state", () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = makeConversation();
  });

  test("starts with dirty=true and null context", () => {
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(true);
    expect(conversation.getWorkspaceTopLevelContext()).toBeNull();
  });

  test("refreshWorkspaceTopLevelContextIfNeeded populates context and clears dirty", () => {
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);
    expect(conversation.getWorkspaceTopLevelContext()).not.toBeNull();
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "<workspace>",
    );
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "</workspace>",
    );
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      `Current conversation attachments: ${conversationAttachmentsPath}`,
    );
  });

  test("refreshWorkspaceTopLevelContextIfNeeded no-ops when not dirty and cache exists", () => {
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    const first = conversation.getWorkspaceTopLevelContext();

    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    const second = conversation.getWorkspaceTopLevelContext();

    // Same reference — no recomputation
    expect(first).toBe(second);
  });

  test("markWorkspaceTopLevelDirty sets dirty flag", () => {
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);

    conversation.markWorkspaceTopLevelDirty();
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("refresh after marking dirty produces fresh context", () => {
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    conversation.markWorkspaceTopLevelDirty();
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    expect(conversation.getWorkspaceTopLevelContext()).not.toBeNull();
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "<workspace>",
    );
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);
  });

  test("renders client-reported host env when set on the conversation", () => {
    conversation.hostHomeDir = "/Users/alice";
    conversation.hostUsername = "alice";
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    const block = conversation.getWorkspaceTopLevelContext();
    expect(block).not.toBeNull();
    expect(block!).toContain("Host home directory: /Users/alice");
    expect(block!).toContain("Host username: alice");
  });

  test("falls back to daemon os info when client host env is absent", async () => {
    const { homedir, userInfo } = await import("node:os");
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    const block = conversation.getWorkspaceTopLevelContext();
    expect(block).not.toBeNull();
    expect(block!).toContain(`Host home directory: ${homedir()}`);
    expect(block!).toContain(`Host username: ${userInfo().username}`);
  });

  test("re-renders with updated host env after marking dirty", () => {
    conversation.hostHomeDir = "/Users/alice";
    conversation.hostUsername = "alice";
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "Host home directory: /Users/alice",
    );

    conversation.hostHomeDir = "/Users/bob";
    conversation.hostUsername = "bob";
    conversation.markWorkspaceTopLevelDirty();
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    const block = conversation.getWorkspaceTopLevelContext();
    expect(block).not.toBeNull();
    expect(block!).toContain("Host home directory: /Users/bob");
    expect(block!).toContain("Host username: bob");
    expect(block!).not.toContain("Host home directory: /Users/alice");
    expect(block!).not.toContain("Host username: alice");
  });

  test("falls back to os info after clearing macOS host env (cross-interface reuse)", async () => {
    const { homedir, userInfo } = await import("node:os");

    // Simulate a macOS turn populating host env.
    conversation.hostHomeDir = "/Users/alice";
    conversation.hostUsername = "alice";
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "Host home directory: /Users/alice",
    );

    // Simulate a subsequent non-macOS turn (iOS, CLI, channel) on the same
    // conversation clearing the host env — without the clear, the stale
    // macOS paths would leak into the next render.
    conversation.hostHomeDir = undefined;
    conversation.hostUsername = undefined;
    conversation.markWorkspaceTopLevelDirty();
    conversation.refreshWorkspaceTopLevelContextIfNeeded();

    const block = conversation.getWorkspaceTopLevelContext();
    expect(block).not.toBeNull();
    expect(block!).toContain(`Host home directory: ${homedir()}`);
    expect(block!).toContain(`Host username: ${userInfo().username}`);
    expect(block!).not.toContain("Host home directory: /Users/alice");
    expect(block!).not.toContain("Host username: alice");
  });

  // -------------------------------------------------------------------------
  // applyHostEnvFromTransport — capability-gated setter
  // -------------------------------------------------------------------------

  test("applyHostEnvFromTransport populates fields for host-proxy transports", () => {
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    expect(conversation.hostHomeDir).toBe("/Users/alice");
    expect(conversation.hostUsername).toBe("alice");
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(true);

    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    const block = conversation.getWorkspaceTopLevelContext();
    expect(block!).toContain("Host home directory: /Users/alice");
    expect(block!).toContain("Host username: alice");
  });

  test("applyHostEnvFromTransport clears fields for non-host-proxy transports", () => {
    // Seed with a host-proxy turn.
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });
    expect(conversation.hostHomeDir).toBe("/Users/alice");

    // Apply a non-host-proxy transport — should clear the stored values so
    // the next render doesn't leak them from a cross-interface reuse.
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "ios",
    });

    expect(conversation.hostHomeDir).toBeUndefined();
    expect(conversation.hostUsername).toBeUndefined();
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("applyHostEnvFromTransport clears fields for chrome-extension (browser-only)", () => {
    // chrome-extension supports only host_browser — the no-arg supportsHostProxy
    // returns false for it, so the gate treats it as a non-host-proxy transport
    // for the purposes of host env (no local filesystem to address).
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "chrome-extension",
    });

    expect(conversation.hostHomeDir).toBeUndefined();
    expect(conversation.hostUsername).toBeUndefined();
  });

  test("applyHostEnvFromTransport handles transport with no interfaceId", () => {
    // Seed and then apply a transport without an interfaceId (legacy/channel
    // paths may omit it). The gate should clear any stored host env.
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
    });

    expect(conversation.hostHomeDir).toBeUndefined();
    expect(conversation.hostUsername).toBeUndefined();
  });

  test("applyHostEnvFromTransport does not mark dirty when values are unchanged", () => {
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });
    // Render once so the dirty flag clears.
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);

    // Re-apply the same values — dirty flag should remain false so we don't
    // thrash the cached workspace block on every message.
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);
  });

  test("applyHostEnvFromTransport marks dirty when macOS values change", () => {
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });
    conversation.refreshWorkspaceTopLevelContextIfNeeded();
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);

    // New values — should mark dirty so the next render picks them up.
    conversation.applyHostEnvFromTransport({
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/bob",
      hostUsername: "bob",
    });
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("workspace hints follow the resolved legacy directory when canonical is absent", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "conversation-workspace-cache-state-"),
    );
    const legacyDirName = `conv-1_2026-03-19T12-00-00.000Z`;
    mkdirSync(join(workspaceRoot, "conversations", legacyDirName), {
      recursive: true,
    });

    try {
      const tempConversation = makeConversation(workspaceRoot);
      tempConversation.refreshWorkspaceTopLevelContextIfNeeded();

      expect(tempConversation.getWorkspaceTopLevelContext()!).toContain(
        `Current conversation attachments: conversations/${legacyDirName}/attachments/`,
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
