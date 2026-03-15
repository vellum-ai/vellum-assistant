import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Configurable agent loop behavior
// ---------------------------------------------------------------------------

let agentLoopScript: (onEvent: (event: AgentEvent) => void) => void = () => {};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
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
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    memory: { enabled: false },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
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
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    reason: null,
    provider: "mock",
    model: "mock",
    injectedText: "",
    semanticHits: 0,
    recencyHits: 0,
    mergedCount: 0,
    selectedCount: 0,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
  }),
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
      agentLoopScript(onEvent);
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 10,
      });
      const assistantMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      };
      onEvent({ type: "message_complete", message: assistantMessage });
      return [...messages, assistantMessage];
    }
  },
}));
mock.module("../memory/canonical-guardian-store.js", () => ({
  listPendingCanonicalGuardianRequestsByDestinationConversation: () => [],
  listCanonicalGuardianRequests: () => [],
  listPendingRequestsByConversationScope: () => [],
  createCanonicalGuardianRequest: () => ({
    id: "mock-cg-id",
    code: "MOCK",
    status: "pending",
  }),
  getCanonicalGuardianRequest: () => null,
  getCanonicalGuardianRequestByCode: () => null,
  updateCanonicalGuardianRequest: () => {},
  resolveCanonicalGuardianRequest: () => {},
  createCanonicalGuardianDelivery: () => ({ id: "mock-cgd-id" }),
  listCanonicalGuardianDeliveries: () => [],
  listPendingCanonicalGuardianRequestsByDestinationChat: () => [],
  updateCanonicalGuardianDelivery: () => {},
  generateCanonicalRequestCode: () => "MOCK-CODE",
}));

import { Session } from "../daemon/session.js";

function makeSession(): Session {
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
  return new Session(
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

describe("Session workspace dirty on file mutations", () => {
  beforeEach(() => {
    agentLoopScript = () => {};
  });

  test("successful file_write marks workspace dirty", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Prime the cache so dirty=false
    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_1",
        name: "file_write",
        input: { path: "/tmp/a.txt", content: "hi" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "Written",
        isError: false,
      });
    };

    await session.processMessage("Write a file", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("successful file_edit marks workspace dirty", async () => {
    const session = makeSession();
    await session.loadFromDb();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_2",
        name: "file_edit",
        input: { path: "/tmp/a.txt", old_str: "a", new_str: "b" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_2",
        content: "Edited",
        isError: false,
      });
    };

    await session.processMessage("Edit a file", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("file_write with isError still marks workspace dirty (secret-detection block)", async () => {
    // ToolExecutor can physically write the file and then flip isError=true
    // in secret-detection block mode — the filesystem has changed.
    const session = makeSession();
    await session.loadFromDb();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_3",
        name: "file_write",
        input: { path: "/tmp/a.txt", content: "hi" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_3",
        content: "Blocked: secret detected",
        isError: true,
      });
    };

    await session.processMessage("Write a file", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("successful bash marks workspace dirty", async () => {
    const session = makeSession();
    await session.loadFromDb();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_5",
        name: "bash",
        input: { command: "mkdir /tmp/new-dir" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_5",
        content: "",
        isError: false,
      });
    };

    await session.processMessage("Run a command", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("failed bash still marks workspace dirty (commands can mutate before failing)", async () => {
    const session = makeSession();
    await session.loadFromDb();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_6",
        name: "bash",
        input: { command: "false" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_6",
        content: "exit code 1",
        isError: true,
      });
    };

    await session.processMessage("Run a command", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(true);
  });

  test("non-mutation tools do NOT mark workspace dirty", async () => {
    const session = makeSession();
    await session.loadFromDb();

    session.refreshWorkspaceTopLevelContextIfNeeded();
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);

    agentLoopScript = (onEvent) => {
      onEvent({
        type: "tool_use",
        id: "tu_4",
        name: "file_read",
        input: { path: "/tmp/a.txt" },
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_4",
        content: "file contents",
        isError: false,
      });
    };

    await session.processMessage("Read a file", [], () => {});
    expect(session.isWorkspaceTopLevelDirty()).toBe(false);
  });
});
