import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock dependencies — follows session-profile-injection.test.ts pattern
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
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
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
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
  deleteMessageById: () => ({ segmentIds: [], orphanedItemIds: [] }),
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
  injectMemoryRecallAsSeparateMessage: (msgs: Message[]) => msgs,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
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

function makeSession(): Conversation {
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
    "/tmp",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation workspace cache state", () => {
  let session: Conversation;

  beforeEach(() => {
    session = makeSession();
  });

  test("starts with dirty=true and null context", () => {
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
    expect(session.getWorkspaceTopLevelContext()).toBeNull();
  });

  test("refreshWorkspaceTopLevelContextIfNeeded populates context and clears dirty", () => {
    session.refreshWorkspaceTopLevelContextIfNeeded();

    expect(session.isWorkspaceTopLevelDirty()).toBe(false);
    expect(session.getWorkspaceTopLevelContext()).not.toBeNull();
    expect(session.getWorkspaceTopLevelContext()!).toContain(
      "<workspace_top_level>",
    );
    expect(session.getWorkspaceTopLevelContext()!).toContain(
      "</workspace_top_level>",
    );
  });

  test("refreshWorkspaceTopLevelContextIfNeeded no-ops when not dirty and cache exists", () => {
    session.refreshWorkspaceTopLevelContextIfNeeded();
    const first = session.getWorkspaceTopLevelContext();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    const second = session.getWorkspaceTopLevelContext();

    // Same reference — no recomputation
    expect(first).toBe(second);
  });

  test("markWorkspaceTopLevelDirty sets dirty flag", () => {
    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    session.markWorkspaceTopLevelDirty();
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("refresh after marking dirty produces fresh context", () => {
    session.refreshWorkspaceTopLevelContextIfNeeded();

    session.markWorkspaceTopLevelDirty();
    session.refreshWorkspaceTopLevelContextIfNeeded();

    expect(session.getWorkspaceTopLevelContext()).not.toBeNull();
    expect(session.getWorkspaceTopLevelContext()!).toContain(
      "<workspace_top_level>",
    );
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);
  });
});
