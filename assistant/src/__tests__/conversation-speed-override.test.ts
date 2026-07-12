/**
 * Tests for per-conversation speed override.
 *
 * Verifies that the Conversation constructor resolves speed from the
 * per-conversation speedOverride parameter first, falling back to the
 * global config speed setting.
 */
import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopConfig } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

import { setConfig } from "./helpers/set-config.js";

// Controllable global speed, seeded into the real workspace config per test.
// This file's blanket assistant-feature-flags mock forces the
// override-or-default resolution flag ON; the speed under test rides in the
// mainAgent call-site tweak (applies under both semantics) as well as
// llm.default.
function seedConfigSpeed(speed: "standard" | "fast"): void {
  setConfig("llm", {
    default: { speed },
    callSites: {
      mainAgent: {
        speed,
        contextWindow: { maxInputTokens: 100000 },
      },
    },
  });
}

// Feature flag mock — fast-mode enabled for all tests in this file.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "fast-mode") {
      return true;
    }
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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../persistence/attachments-store.js", () => ({
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

mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
    constructor() {}
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
    resetOverflowRecovery() {}
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../persistence/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

// Capture AgentLoop constructor config for assertions.
let lastAgentLoopConfig: Partial<AgentLoopConfig> | undefined;

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor(options?: {
      provider?: unknown;
      systemPrompt?: string;
      config?: Partial<AgentLoopConfig>;
    }) {
      lastAgentLoopConfig = options?.config;
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
    async run(_options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<Message[]> {
      return [];
    }
  },
}));

mock.module("../contacts/canonical-guardian-store.js", () => ({
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
    seedConfigSpeed("fast");
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-override-1",
      makeProvider(),
      "system prompt",
      makeSendToClient(),
      "/tmp",
      { maxTokens: 4096, speedOverride: "standard" },
    );

    expect(lastAgentLoopConfig).toBeDefined();
    // When speedOverride is "standard", the AgentLoop should NOT receive speed: "fast"
    expect(lastAgentLoopConfig!.speed).toBeUndefined();
  });

  test("no speedOverride uses global config speed", () => {
    seedConfigSpeed("fast");
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-global-1",
      makeProvider(),
      "system prompt",
      makeSendToClient(),
      "/tmp",
      { maxTokens: 4096 },
    );

    expect(lastAgentLoopConfig).toBeDefined();
    expect(lastAgentLoopConfig!.speed).toBe("fast");
  });

  test("speedOverride 'fast' enables fast mode even when global config is 'standard'", () => {
    seedConfigSpeed("standard");
    lastAgentLoopConfig = undefined;

    new Conversation(
      "conv-speed-override-fast-1",
      makeProvider(),
      "system prompt",
      makeSendToClient(),
      "/tmp",
      { maxTokens: 4096, speedOverride: "fast" },
    );

    expect(lastAgentLoopConfig).toBeDefined();
    expect(lastAgentLoopConfig!.speed).toBe("fast");
  });
});
