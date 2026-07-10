/**
 * Verifies that `callSite` threads from `Conversation.processMessage`
 * options all the way down to the per-call provider config, and that
 * user-initiated turns default to `'mainAgent'` when no caller-supplied
 * `callSite` is set.
 *
 * The test mocks `AgentLoop.run()` so it can capture the `callSite` option
 * the conversation passes via `AgentLoopRunOptions` after `processMessage`
 * runs the slash-resolver and runtime-injection pipeline. Adapter callers
 * (heartbeat, filing, scheduler) pass an explicit `callSite` so
 * `RetryProvider` resolves their per-call config from `llm.callSites.<id>`.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// Use an object wrapper so TypeScript doesn't narrow the captured type to
// `undefined` based on the initial assignment in the test setup.
const captured: {
  callSite?: string;
  constructorMaxTokens?: unknown;
} = {};

function clearCaptured(): void {
  captured.callSite = undefined;
  captured.constructorMaxTokens = undefined;
}

const mockProviderStub = { name: "mock-provider" };
mock.module("../providers/registry.js", () => ({
  getProvider: () => mockProviderStub,
  initializeProviders: async () => {},
  listProviders: () => ["anthropic", "openai", "gemini"],
  resolveProviderFromConnection: async () => mockProviderStub,
}));

// Connection-aware resolver path: satisfy
// `tryResolveProviderForConnectionName` lookups so resolveDefaultProvider
// returns a usable provider for the inline `anthropic-conn` fixture.
mock.module("../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) => ({
    id: 1,
    name,
    provider: "anthropic",
    auth_strategy: "user_managed_credential",
    credential_alias: null,
    metadata_json: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    llm: {
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-6",
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
      profiles: {
        // Disable the catalog default so resolution lands on llm.default.
        balanced: { source: "managed", status: "disabled" },
      },
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
    memory: {
      v2: { enabled: false },
      retrieval: { scratchpadInjection: { enabled: true } },
    },
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

mock.module("../prompts/persona-resolver.js", () => ({
  resolvePersonaContext: () => ({
    userPersona: undefined,
    channelPersona: undefined,
    userSlug: undefined,
  }),
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

// Stub workspace-git so the test doesn't run real `git init` / `git add -A`
// against the workingDir. On GitHub-hosted runners /tmp contains
// root-owned systemd-private-* directories that return EACCES, and the
// resulting retry/backoff path takes several seconds — enough to time
// out this test even though the callSite-threading assertion is unrelated.
mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
    commitIfDirty: async () => ({ committed: false }),
  }),
}));

let mockDbMessages: Array<{ id: string; role: string; content: string }> = [];
let mockConversation: Record<string, unknown> | null = null;

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => mockDbMessages,
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: () => ({ id: "new-msg" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
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

// Mock AgentLoop to capture the callSite argument that runAgentLoopImpl passes
// via the options object (see assistant/src/agent/loop.ts → AgentLoopConstructorOptions).
mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor(options?: {
      provider?: unknown;
      systemPrompt?: string;
      config?: Record<string, unknown>;
    }) {
      captured.constructorMaxTokens = options?.config?.maxTokens;
    }
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    async run(options: {
      messages: Message[];
      onEvent: (event: Record<string, unknown>) => void;
      callSite?: string;
    }): Promise<Message[]> {
      const { messages, onEvent } = options;
      captured.callSite = options.callSite;
      onEvent({
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        model: "mock",
        providerDurationMs: 0,
      });
      return [
        ...messages,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
    }
  },
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

import { Conversation } from "../daemon/conversation.js";
import {
  clearAllActiveConversations,
  getOrCreateConversation,
} from "../daemon/conversation-store.js";

function makeConversation(): Conversation {
  const provider = {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [{ type: "text", text: "hi" }],
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
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
}

describe("processMessage callSite threading", () => {
  test("threads options.callSite='heartbeatAgent' down to agentLoop.run()", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();

    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage({
      content: "Heartbeat tick",
      attachments: [],
      callSite: "heartbeatAgent",
    });

    expect(captured.callSite).toBe("heartbeatAgent");
  });

  test("defaults to 'mainAgent' when not supplied", async () => {
    mockConversation = {
      id: "conv-1",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();

    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage({
      content: "Plain user message",
      attachments: [],
    });

    expect(captured.callSite).toBe("mainAgent");
  });

  test("does not pin default maxTokens when maxResponseTokens is absent", async () => {
    mockConversation = {
      id: "conv-store-default",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();
    clearAllActiveConversations();

    await getOrCreateConversation("conv-store-default");

    expect(captured.constructorMaxTokens).toBeUndefined();
  });

  test("preserves explicit maxResponseTokens at conversation creation", async () => {
    mockConversation = {
      id: "conv-store-explicit",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();
    clearAllActiveConversations();

    await getOrCreateConversation("conv-store-explicit", {
      maxResponseTokens: 1234,
    });

    expect(captured.constructorMaxTokens).toBe(1234);
  });

  test("applies clientTimezone in the create and reuse transport metadata path", async () => {
    mockConversation = {
      id: "conv-store-client-timezone",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();
    clearAllActiveConversations();

    const conversation = await getOrCreateConversation(
      "conv-store-client-timezone",
      {
        transport: {
          channelId: "vellum",
          interfaceId: "macos",
          clientTimezone: "america/new_york",
        },
      },
    );

    expect(conversation.clientTimezone).toBe("America/New_York");

    await getOrCreateConversation("conv-store-client-timezone", {
      transport: {
        channelId: "vellum",
        interfaceId: "ios",
        clientTimezone: "europe/london",
      },
    });

    expect(conversation.clientTimezone).toBe("Europe/London");
  });

  test("applies clientOs in the create and reuse transport metadata path", async () => {
    mockConversation = {
      id: "conv-store-client-os",
      contextSummary: null,
      contextCompactedMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    };
    mockDbMessages = [];
    clearCaptured();
    clearAllActiveConversations();

    // `interface` is always the transport surface (here "web"); the OS is
    // carried separately as `clientOs` and must be applied on both the create
    // and reuse paths so each turn reflects its own surface.
    const conversation = await getOrCreateConversation("conv-store-client-os", {
      transport: {
        channelId: "vellum",
        interfaceId: "web",
        clientOs: "macos",
      },
    });

    expect(conversation.clientOs).toBe("macos");

    await getOrCreateConversation("conv-store-client-os", {
      transport: {
        channelId: "vellum",
        interfaceId: "web",
        clientOs: "ios",
      },
    });

    expect(conversation.clientOs).toBe("ios");
  });
});
