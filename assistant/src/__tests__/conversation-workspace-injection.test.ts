import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Track agent loop calls
// ---------------------------------------------------------------------------

let runCalls: Message[][] = [];
let agentLoopScript: (onEvent: (event: AgentEvent) => void) => void = () => {};
let scanCallCount = 0;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
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

    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: false, streamThinking: true },
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
      },
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: { enabled: false },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
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
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
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
    mergedCount: 0,
    selectedCount: 0,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
  }),
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

mock.module("../workspace/top-level-scanner.js", () => ({
  MAX_TOP_LEVEL_ENTRIES: 120,
  scanTopLevelDirectories: (rootPath: string) => {
    scanCallCount++;
    return {
      rootPath,
      directories: ["src", "tests", "docs"],
      files: ["README.md", "package.json"],
      truncated: false,
    };
  },
}));

// Avoid real workspace-git initialization on /tmp — on CI runners,
// `git add -A` under /tmp hits permission errors on systemd-private dirs,
// which blocks the agent loop for long enough to trip the 5s test timeout
// on the first test case before the circuit breaker opens.
mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
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
      runCalls.push(messages);
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

import { Conversation } from "../daemon/conversation.js";

function makeConversation(): Conversation {
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

function messageText(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation workspace injection", () => {
  beforeEach(() => {
    runCalls = [];
    agentLoopScript = () => {};
    scanCallCount = 0;
  });

  test("runtime messages include workspace top-level context", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    expect(runtimeUser.role).toBe("user");
    const text = messageText(runtimeUser);
    expect(text).toContain("<workspace>");
    expect(text).toContain("</workspace>");
  });

  test("workspace context includes root path and directories", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const text = messageText(runtimeUser);
    expect(text).toContain("Root: /tmp");
    expect(text).toContain("Directories: src, tests, docs");
    expect(text).toContain("Files: README.md, package.json");
  });

  test("workspace context is prepended before user text", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const firstBlock = runtimeUser.content[0];
    expect(firstBlock.type).toBe("text");
    const firstText = (firstBlock as { type: "text"; text: string }).text;
    expect(firstText).toContain("<workspace>");
  });

  test("workspace context persists in history (not stripped between turns)", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});

    // Workspace blocks use <workspace> tag which is intentionally NOT stripped.
    const persistedMessages = conversation.getMessages();
    const userMsg = persistedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const text = messageText(userMsg!);
    expect(text).toContain("<workspace>");
  });

  test("second message does NOT include workspace block", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // First message — workspace is injected
    await conversation.processMessage("Hello", [], () => {});
    expect(runCalls).toHaveLength(1);
    const firstCallUser = runCalls[0][runCalls[0].length - 1];
    const firstText = messageText(firstCallUser);
    expect(firstText).toContain("<workspace>");

    // Second message — workspace is NOT injected (not first message, no compaction)
    await conversation.processMessage("Follow up", [], () => {});
    expect(runCalls).toHaveLength(2);
    const secondCallUser = runCalls[1][runCalls[1].length - 1];
    const secondText = messageText(secondCallUser);
    expect(secondText).not.toContain("<workspace>");
  });
});

describe("Conversation workspace dirty-refresh E2E", () => {
  beforeEach(() => {
    runCalls = [];
    agentLoopScript = () => {};
    scanCallCount = 0;
  });

  test("first turn computes snapshot", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});

    expect(scanCallCount).toBe(1);
    const text = messageText(runCalls[0][runCalls[0].length - 1]);
    expect(text).toContain("src, tests, docs");
  });

  test("second turn without mutation reuses cache", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});
    const afterFirst = scanCallCount;

    await conversation.processMessage("Again", [], () => {});

    // Scanner should NOT have been called again
    expect(scanCallCount).toBe(afterFirst);
  });

  test("successful file_edit causes refresh next turn", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});
    const afterFirst = scanCallCount;

    // Simulate a turn where the agent uses file_edit
    agentLoopScript = (onEvent) => {
      onEvent({ type: "tool_use", id: "tu-1", name: "file_edit", input: {} });
      onEvent({
        type: "tool_result",
        toolUseId: "tu-1",
        content: "done",
        isError: false,
      });
    };
    await conversation.processMessage("Edit a file", [], () => {});

    // No rescan should happen during the mutation turn itself
    const afterMutation = scanCallCount;
    expect(afterMutation).toBe(afterFirst);

    // Next turn should trigger exactly one fresh scan
    agentLoopScript = () => {};
    await conversation.processMessage("What happened?", [], () => {});

    expect(scanCallCount).toBe(afterMutation + 1);
  });

  test("successful bash causes refresh next turn", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});
    const afterFirst = scanCallCount;

    agentLoopScript = (onEvent) => {
      onEvent({ type: "tool_use", id: "tu-2", name: "bash", input: {} });
      onEvent({
        type: "tool_result",
        toolUseId: "tu-2",
        content: "ok",
        isError: false,
      });
    };
    await conversation.processMessage("Run a command", [], () => {});

    // No rescan should happen during the mutation turn itself
    const afterMutation = scanCallCount;
    expect(afterMutation).toBe(afterFirst);

    // Next turn should trigger exactly one fresh scan
    agentLoopScript = () => {};
    await conversation.processMessage("What now?", [], () => {});

    expect(scanCallCount).toBe(afterMutation + 1);
  });

  test("failed tool results do not trigger refresh", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage("Hello", [], () => {});
    const afterFirst = scanCallCount;

    agentLoopScript = (onEvent) => {
      onEvent({ type: "tool_use", id: "tu-3", name: "file_edit", input: {} });
      onEvent({
        type: "tool_result",
        toolUseId: "tu-3",
        content: "error",
        isError: true,
      });
    };
    await conversation.processMessage("Try editing", [], () => {});

    agentLoopScript = () => {};
    await conversation.processMessage("What happened?", [], () => {});

    // Scanner should NOT have been re-called since the tool failed
    expect(scanCallCount).toBe(afterFirst);
  });
});
