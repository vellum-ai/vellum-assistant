import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/ipc-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Session import so Bun applies them at load time.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/test.sock",
  getDataDir: () => "/tmp",
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getPendingDeliveryByConversation: () => null,
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
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: "mock-model",
      maxSummaryTokens: 512,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    memory: { retrieval: { injectionStrategy: "inline" } },
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

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

const addMessageCalls: Array<{
  convId: string;
  role: string;
  content: string;
}> = [];

mock.module("../memory/conversation-crud.js", () => ({
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
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
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: "conv-1" }),
  addMessage: (convId: string, role: string, content: string) => {
    addMessageCalls.push({ convId, role, content });
    return { id: `msg-${Date.now()}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module("../memory/admin.js", () => ({
  getMemoryConflictAndCleanupStats: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: {
      resolvedBacklog: 0,
      supersededBacklog: 0,
      resolvedCompleted24h: 0,
      supersededCompleted24h: 0,
    },
  }),
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

// Mock skill catalog — "start-the-day" and "browser" are available
mock.module("../skills/catalog.js", () => ({
  loadSkillCatalog: () => [
    {
      id: "start-the-day",
      name: "Start the Day",
      displayName: "Start the Day",
      description: "Morning routine skill",
      directoryPath: "/skills/start-the-day",
      skillFilePath: "/skills/start-the-day/SKILL.md",
      userInvocable: true,
      disableModelInvocation: false,
      source: "managed",
    },
    {
      id: "browser",
      name: "Browser",
      displayName: "Browser",
      description:
        "Navigate and interact with web pages using a headless browser",
      directoryPath: "/skills/browser",
      skillFilePath: "/skills/browser/SKILL.md",
      userInvocable: true,
      disableModelInvocation: false,
      source: "bundled",
    },
  ],
  loadSkillBySelector: () => null,
  ensureSkillIcon: () => {},
}));

mock.module("../skills/skill-state.js", () => ({
  resolveSkillStates: (catalog: Record<string, unknown>[]) =>
    catalog.map((s) => ({
      summary: s,
      state: "enabled",
      degraded: false,
    })),
}));

// ---------------------------------------------------------------------------
// AgentLoop mock — tracks whether run() was called
// ---------------------------------------------------------------------------

let agentLoopRunCalled = false;

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      agentLoopRunCalled = true;
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      };
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 100,
      });
      onEvent({ type: "message_complete", message: assistantMsg });
      return [...messages, assistantMsg];
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

// ---------------------------------------------------------------------------
// Import Session AFTER mocks are registered.
// ---------------------------------------------------------------------------

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

describe("Session slash command — unknown", () => {
  beforeEach(() => {
    agentLoopRunCalled = false;
    addMessageCalls.length = 0;
  });

  test("unknown slash emits deterministic assistant response", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    await session.processMessage("/not-a-skill", [], onEvent);

    // Should have emitted assistant_text_delta with the unknown message
    const textDeltas = events.filter((e) => e.type === "assistant_text_delta");
    expect(textDeltas.length).toBe(1);
    const delta = textDeltas[0] as { text: string };
    expect(delta.text).toContain("Unknown command `/not-a-skill`");
    expect(delta.text).toContain("/start-the-day");

    // Should have emitted message_complete
    const completes = events.filter((e) => e.type === "message_complete");
    expect(completes.length).toBe(1);
  });

  test("unknown slash returns a non-empty messageId", async () => {
    const session = makeSession();
    const messageId = await session.processMessage(
      "/not-a-skill",
      [],
      () => {},
    );
    expect(messageId).toBeTruthy();
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
  });

  test("no agent loop execution occurs for unknown slash", async () => {
    const session = makeSession();
    await session.processMessage("/not-a-skill", [], () => {});
    expect(agentLoopRunCalled).toBe(false);
  });

  test("unknown slash persists both user and assistant messages", async () => {
    const session = makeSession();
    await session.processMessage("/not-a-skill", [], () => {});

    // Should persist exactly two messages: user + assistant
    const roles = addMessageCalls.map((c) => c.role);
    expect(roles).toEqual(["user", "assistant"]);

    // The assistant message content should contain the unknown-command text
    const assistantContent = addMessageCalls[1].content;
    expect(assistantContent).toContain("Unknown command");
  });

  test("unknown slash command output includes /browser in available commands", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    await session.processMessage("/not-a-skill", [], onEvent);

    const textDeltas = events.filter((e) => e.type === "assistant_text_delta");
    expect(textDeltas.length).toBe(1);
    const delta = textDeltas[0] as { text: string };
    expect(delta.text).toContain("/browser");
    expect(delta.text).toContain("/start-the-day");
  });

  test("normal messages still go through standard path", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    await session.processMessage("hello world", [], (msg) => events.push(msg));
    expect(agentLoopRunCalled).toBe(true);
  });
});
