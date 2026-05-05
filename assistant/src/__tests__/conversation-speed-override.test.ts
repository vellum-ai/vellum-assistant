/**
 * Tests for per-conversation speed override.
 *
 * Verifies that the Conversation constructor resolves speed from the
 * per-conversation speedOverride parameter first, falling back to the
 * global config speed setting.
 */
import { describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  AgentLoopConfig,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

// Controllable config mock — speed and feature flag behavior are test-specific.
let mockConfigSpeed: "standard" | "fast" = "fast";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "high" as const,
        speed: mockConfigSpeed,
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
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Feature flag mock — fast-mode enabled for all tests in this file.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "fast-mode") return true;
    return true;
  },
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
  addMessage: () => ({ id: `msg-${Date.now()}` }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {},
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    semanticHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
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
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

// Capture AgentLoop constructor config for assertions.
let lastAgentLoopConfig: Partial<AgentLoopConfig> | undefined;

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor(
      _provider: unknown,
      _systemPrompt: string,
      config?: Partial<AgentLoopConfig>,
    ) {
      lastAgentLoopConfig = config;
    }
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    getActiveModel() {
      return undefined;
    }
    async run(
      _messages: Message[],
      _onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (
        checkpoint: CheckpointInfo,
      ) => CheckpointDecision | Promise<CheckpointDecision>,
    ): Promise<Message[]> {
      return [];
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
// Import Conversation AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return {
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
}

function makeSendToClient(): (msg: ServerMessage) => void {
  return () => {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-conversation speed override", () => {
  test("speedOverride 'standard' prevents fast mode even when global config is 'fast'", () => {
    mockConfigSpeed = "fast";
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-override-1",
      makeProvider(),
      "system prompt",
      4096,
      makeSendToClient(),
      "/tmp",
      undefined, // sharedCesClient
      "standard", // speedOverride
    );

    expect(lastAgentLoopConfig).toBeDefined();
    // When speedOverride is "standard", the AgentLoop should NOT receive speed: "fast"
    expect(lastAgentLoopConfig!.speed).toBeUndefined();
  });

  test("no speedOverride uses global config speed", () => {
    mockConfigSpeed = "fast";
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-global-1",
      makeProvider(),
      "system prompt",
      4096,
      makeSendToClient(),
      "/tmp",
      undefined, // sharedCesClient
      // no speedOverride — should fall back to global config "fast"
    );

    expect(lastAgentLoopConfig).toBeDefined();
    expect(lastAgentLoopConfig!.speed).toBe("fast");
  });

  test("speedOverride 'fast' enables fast mode even when global config is 'standard'", () => {
    mockConfigSpeed = "standard";
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-override-fast-1",
      makeProvider(),
      "system prompt",
      4096,
      makeSendToClient(),
      "/tmp",
      undefined, // sharedCesClient
      "fast", // speedOverride
    );

    expect(lastAgentLoopConfig).toBeDefined();
    expect(lastAgentLoopConfig!.speed).toBe("fast");
  });
});
