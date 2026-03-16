import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Conversation import so Bun applies them at load time.
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
  getConversationType: () => "default",
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

    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
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
mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [
    {
      id: "start-the-day",
      name: "Start the Day",
      displayName: "Start the Day",
      description: "Morning routine skill",
      directoryPath: "/skills/start-the-day",
      skillFilePath: "/skills/start-the-day/SKILL.md",

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

      source: "bundled",
    },
  ],
  loadSkillBySelector: () => null,
  ensureSkillIcon: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: (catalog: Record<string, unknown>[]) =>
    catalog.map((s) => ({
      summary: s,
      state: "enabled",
    })),
}));

// ---------------------------------------------------------------------------
// AgentLoop mock — tracks whether run() was called
// ---------------------------------------------------------------------------

let agentLoopRunCalled = false;

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
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
// Import Conversation AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

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

describe("Conversation slash command — passthrough for unknown tokens", () => {
  beforeEach(() => {
    agentLoopRunCalled = false;
    addMessageCalls.length = 0;
  });

  test("unknown slash-like input passes through to agent loop", async () => {
    const session = makeSession();
    await session.processMessage("/not-a-skill", [], () => {});

    // Should go through the normal agent loop path
    expect(agentLoopRunCalled).toBe(true);
  });

  test("normal messages still go through standard path", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    await session.processMessage("hello world", [], (msg) => events.push(msg));
    expect(agentLoopRunCalled).toBe(true);
  });
});
