/**
 * Tests for cascading approval decisions to matching pending confirmations.
 *
 * When a user resolves one confirmation with allow or deny, other pending
 * confirmations in the same conversation that match may be auto-resolved.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Minimatch } from "minimatch";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { ConfirmationStateChanged } from "../daemon/message-types/messages.js";
import type { Message, ProviderResponse } from "../providers/types.js";
import type { ConfirmationDetails } from "../runtime/pending-interactions.js";

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
    timeouts: { permissionTimeoutSec: 300 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
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

// Trust store mock — uses real minimatch for patternMatchesCandidate so the
// mock doesn't break trust-store-pattern-matches.test.ts when both files run
// in the same Bun process (mock.module leaks across test files).
mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
  patternMatchesCandidate: (pattern: string, candidate: string): boolean => {
    try {
      return new Minimatch(pattern).match(candidate);
    } catch {
      return false;
    }
  },
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

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
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
// Import Conversation and pendingInteractions AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONV_ID = "conv-cascade-test";

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

function makeConversation(
  sendToClient?: (msg: ServerMessage) => void,
  conversationId = CONV_ID,
): Conversation {
  return new Conversation(
    conversationId,
    makeProvider(),
    "system prompt",
    4096,
    sendToClient ?? (() => {}),
    process.env.VELLUM_WORKSPACE_DIR!,
  );
}

/**
 * Seed a pending confirmation directly in the prompter's internal map.
 */
function seedPendingConfirmation(
  conversation: Conversation,
  requestId: string,
): void {
  const prompter = conversation["prompter"] as unknown as {
    pending: Map<
      string,
      {
        resolve: (...args: unknown[]) => void;
        reject: (...args: unknown[]) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >;
  };
  prompter.pending.set(requestId, {
    resolve: () => {},
    reject: () => {},
    timer: setTimeout(() => {}, 60_000),
  });
}

/**
 * Register a pending interaction in the pending-interactions tracker with
 * confirmation details.
 */
function registerPendingInteraction(
  requestId: string,
  conversationId: string,
  confirmationDetails?: ConfirmationDetails,
): void {
  pendingInteractions.register(requestId, {
    conversationId,
    kind: "confirmation",
    confirmationDetails,
  });
}

function makeConfirmationDetails(patterns: string[]): ConfirmationDetails {
  return {
    toolName: "bash",
    input: { command: "echo hello" },
    riskLevel: "medium",
    allowlistOptions: patterns.map((p) => ({
      label: p,
      description: `Allow ${p}`,
      pattern: p,
    })),
    scopeOptions: [{ label: "Everywhere", scope: "everywhere" }],
  };
}

beforeEach(() => {
  pendingInteractions.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approval cascading", () => {
  test("allow (one-time) does NOT cascade", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-1");
    seedPendingConfirmation(conversationObj, "req-2");

    registerPendingInteraction(
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:echo world"]),
    );

    conversationObj.handleConfirmationResponse("req-1", "allow");

    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    // Only the primary should be resolved
    expect(confirmMsgs).toHaveLength(1);
    expect(confirmMsgs[0].requestId).toBe("req-1");
  });

  test("deny (one-time) does NOT cascade", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-1");
    seedPendingConfirmation(conversationObj, "req-2");

    registerPendingInteraction(
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:echo world"]),
    );

    conversationObj.handleConfirmationResponse("req-1", "deny");

    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "denied",
    ) as unknown as ConfirmationStateChanged[];

    // Only the primary should be denied
    expect(confirmMsgs).toHaveLength(1);
    expect(confirmMsgs[0].requestId).toBe("req-1");
  });

  test("already-resolved request handled gracefully", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-primary");
    seedPendingConfirmation(conversationObj, "req-stale");

    registerPendingInteraction(
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );
    // Register in pending-interactions but with a request ID that exists
    // in the prompter. We'll remove it from the prompter before cascading
    // reaches it to simulate a stale/already-resolved request.
    registerPendingInteraction(
      "req-stale",
      CONV_ID,
      makeConfirmationDetails(["bash:echo stale"]),
    );

    // Remove req-stale from the prompter's pending map (simulating it was
    // already resolved by another path before cascade reaches it)
    const prompter = conversationObj["prompter"] as unknown as {
      pending: Map<string, unknown>;
    };
    prompter.pending.delete("req-stale");

    // This should not throw — cascade should skip req-stale gracefully
    expect(() => {
      conversationObj.handleConfirmationResponse("req-primary", "allow");
    }).not.toThrow();

    // Only the primary should be resolved
    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    expect(confirmMsgs).toHaveLength(1);
    expect(confirmMsgs[0].requestId).toBe("req-primary");
  });
});
