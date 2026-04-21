/**
 * Verifies that `callSite` threads from `Conversation.processMessage`
 * options all the way down to the per-call provider config, and that
 * user-initiated turns default to `'mainAgent'` when no caller-supplied
 * `callSite` is set.
 *
 * The test mocks `AgentLoop.run()` so it can capture the `callSite` parameter
 * the conversation passes after `processMessage` runs the slash-resolver and
 * runtime-injection pipeline. Adapter callers (heartbeat, filing, scheduler)
 * pass an explicit `callSite` so `RetryProvider` resolves their per-call
 * config from `llm.callSites.<id>`.
 */
import { describe, expect, mock, test } from "bun:test";

import type { Message, ProviderResponse } from "../providers/types.js";

// Use an object wrapper so TypeScript doesn't narrow the captured type to
// `undefined` based on the initial assignment in the test setup.
const captured: { callSite?: string } = {};

function clearCaptured(): void {
  captured.callSite = undefined;
}

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
        provider: "anthropic",
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
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
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

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

// Mock AgentLoop to capture the callSite argument that runAgentLoopImpl passes.
// The 6th positional parameter is `callSite` (see assistant/src/agent/loop.ts).
mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    async run(
      messages: Message[],
      onEvent: (event: Record<string, unknown>) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: unknown,
      callSite?: string,
    ): Promise<Message[]> {
      captured.callSite = callSite;
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
    4096,
    () => {},
    "/tmp",
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

    await conversation.processMessage(
      "Heartbeat tick",
      [],
      () => {},
      undefined, // requestId
      undefined, // activeSurfaceId
      undefined, // currentPage
      { callSite: "heartbeatAgent" },
    );

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

    await conversation.processMessage("Plain user message", [], () => {});

    expect(captured.callSite).toBe("mainAgent");
  });
});
