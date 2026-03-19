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
      "<workspace_top_level>",
    );
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      "</workspace_top_level>",
    );
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      `Current conversation folder: ${conversationPath}`,
    );
    expect(conversation.getWorkspaceTopLevelContext()!).toContain(
      `Attachment files: ${conversationAttachmentsPath}`,
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
      "<workspace_top_level>",
    );
    expect(conversation.isWorkspaceTopLevelDirty()).toBe(false);
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
        `Current conversation folder: conversations/${legacyDirName}/`,
      );
      expect(tempConversation.getWorkspaceTopLevelContext()!).toContain(
        `Attachment files: conversations/${legacyDirName}/attachments/`,
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
