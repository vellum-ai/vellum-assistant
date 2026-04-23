/**
 * Tests for cascading approval decisions to matching pending confirmations.
 *
 * When a user resolves one confirmation with a broad decision (allow_10m,
 * allow_conversation, always_allow, always_deny), other pending confirmations in
 * the same conversation that match are auto-resolved.
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
  conversation: Conversation,
  requestId: string,
  conversationId: string,
  confirmationDetails?: ConfirmationDetails,
): void {
  pendingInteractions.register(requestId, {
    conversation,
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
  test("allow_10m cascades to all pending in same conversation", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    // Seed 3 pending confirmations
    seedPendingConfirmation(conversationObj, "req-1");
    seedPendingConfirmation(conversationObj, "req-2");
    seedPendingConfirmation(conversationObj, "req-3");

    // Register in pending-interactions tracker
    registerPendingInteraction(
      conversationObj,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:ls -la"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-3",
      CONV_ID,
      makeConfirmationDetails(["bash:cat file"]),
    );

    // Resolve the first with allow_10m
    conversationObj.handleConfirmationResponse("req-1", "allow_10m");

    // All 3 should be resolved (approved)
    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    expect(confirmMsgs).toHaveLength(3);

    const resolvedIds = confirmMsgs.map((m) => m.requestId).sort();
    expect(resolvedIds).toEqual(["req-1", "req-2", "req-3"]);
  });

  test("allow_conversation cascades to all pending in same conversation", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-a");
    seedPendingConfirmation(conversationObj, "req-b");
    seedPendingConfirmation(conversationObj, "req-c");

    registerPendingInteraction(
      conversationObj,
      "req-a",
      CONV_ID,
      makeConfirmationDetails(["bash:echo a"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-b",
      CONV_ID,
      makeConfirmationDetails(["bash:echo b"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-c",
      CONV_ID,
      makeConfirmationDetails(["bash:echo c"]),
    );

    conversationObj.handleConfirmationResponse("req-a", "allow_conversation");

    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    expect(confirmMsgs).toHaveLength(3);

    const resolvedIds = confirmMsgs.map((m) => m.requestId).sort();
    expect(resolvedIds).toEqual(["req-a", "req-b", "req-c"]);
  });

  test("temporary override does NOT cascade to different conversation", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-same");
    seedPendingConfirmation(conversationObj, "req-diff");

    // Same conversation
    registerPendingInteraction(
      conversationObj,
      "req-same",
      CONV_ID,
      makeConfirmationDetails(["bash:echo same"]),
    );
    // Different conversation
    registerPendingInteraction(
      conversationObj,
      "req-diff",
      "different-conv",
      makeConfirmationDetails(["bash:echo diff"]),
    );

    // Seed a primary request
    seedPendingConfirmation(conversationObj, "req-primary");
    registerPendingInteraction(
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );

    conversationObj.handleConfirmationResponse("req-primary", "allow_10m");

    const confirmMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    // primary + req-same should be approved, req-diff should NOT
    const resolvedIds = confirmMsgs.map((m) => m.requestId).sort();
    expect(resolvedIds).toContain("req-primary");
    expect(resolvedIds).toContain("req-same");
    expect(resolvedIds).not.toContain("req-diff");
  });

  test("always_allow cascades to pattern-matching pending", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    // Two with matching patterns (asset_materialize:doc.pdf)
    seedPendingConfirmation(conversationObj, "req-match-1");
    seedPendingConfirmation(conversationObj, "req-match-2");
    // One with non-overlapping pattern
    seedPendingConfirmation(conversationObj, "req-nomatch");

    registerPendingInteraction(
      conversationObj,
      "req-match-1",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:doc.pdf"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-match-2",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:report.pdf"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-nomatch",
      CONV_ID,
      makeConfirmationDetails(["bash:rm -rf"]),
    );

    // Primary request
    seedPendingConfirmation(conversationObj, "req-primary");
    registerPendingInteraction(
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:image.png"]),
    );

    conversationObj.handleConfirmationResponse(
      "req-primary",
      "always_allow",
      "asset_materialize:**",
    );

    const approvedMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    const approvedIds = approvedMsgs.map((m) => m.requestId).sort();
    expect(approvedIds).toContain("req-primary");
    expect(approvedIds).toContain("req-match-1");
    expect(approvedIds).toContain("req-match-2");
    expect(approvedIds).not.toContain("req-nomatch");
  });

  test("always_allow does NOT cascade to high-risk pending confirmations", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    // Medium-risk pending — should cascade
    seedPendingConfirmation(conversationObj, "req-medium");
    registerPendingInteraction(
      conversationObj,
      "req-medium",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:report.pdf"]),
    );

    // High-risk pending — should NOT cascade via always_allow
    seedPendingConfirmation(conversationObj, "req-high");
    registerPendingInteraction(conversationObj, "req-high", CONV_ID, {
      toolName: "bash",
      input: { command: "rm -rf /" },
      riskLevel: "high",
      allowlistOptions: [
        {
          label: "asset_materialize:dangerous.bin",
          description: "Allow asset_materialize:dangerous.bin",
          pattern: "asset_materialize:dangerous.bin",
        },
      ],
      scopeOptions: [{ label: "Everywhere", scope: "everywhere" }],
    });

    // Primary request
    seedPendingConfirmation(conversationObj, "req-primary");
    registerPendingInteraction(
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:image.png"]),
    );

    conversationObj.handleConfirmationResponse(
      "req-primary",
      "always_allow",
      "asset_materialize:**",
    );

    const approvedMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "approved",
    ) as unknown as ConfirmationStateChanged[];

    const approvedIds = approvedMsgs.map((m) => m.requestId).sort();
    expect(approvedIds).toContain("req-primary");
    expect(approvedIds).toContain("req-medium");
    expect(approvedIds).not.toContain("req-high");

    // High-risk should still be pending (not emitted at all)
    const allResolvedIds = emitted
      .filter((m) => m.type === "confirmation_state_changed")
      .map((m) => (m as unknown as ConfirmationStateChanged).requestId);
    expect(allResolvedIds).not.toContain("req-high");
  });

  test("always_deny cascades deny to pattern-matching pending", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-match-1");
    seedPendingConfirmation(conversationObj, "req-nomatch");

    registerPendingInteraction(
      conversationObj,
      "req-match-1",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:doc.pdf"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-nomatch",
      CONV_ID,
      makeConfirmationDetails(["bash:rm -rf"]),
    );

    seedPendingConfirmation(conversationObj, "req-primary");
    registerPendingInteraction(
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:image.png"]),
    );

    conversationObj.handleConfirmationResponse(
      "req-primary",
      "always_deny",
      "asset_materialize:**",
    );

    const deniedMsgs = emitted.filter(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).state === "denied",
    ) as unknown as ConfirmationStateChanged[];

    const deniedIds = deniedMsgs.map((m) => m.requestId).sort();
    expect(deniedIds).toContain("req-primary");
    expect(deniedIds).toContain("req-match-1");
    expect(deniedIds).not.toContain("req-nomatch");

    // req-nomatch should still be pending (not emitted at all as approved or denied by cascade)
    const allResolvedIds = emitted
      .filter((m) => m.type === "confirmation_state_changed")
      .map((m) => (m as unknown as ConfirmationStateChanged).requestId);
    expect(allResolvedIds).not.toContain("req-nomatch");
  });

  test("allow (one-time) does NOT cascade", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-1");
    seedPendingConfirmation(conversationObj, "req-2");

    registerPendingInteraction(
      conversationObj,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      conversationObj,
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
      conversationObj,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      conversationObj,
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

  test("cascaded events have source 'system' and causedByRequestId", () => {
    const emitted: ServerMessage[] = [];
    const conversationObj = makeConversation(
      (msg) => emitted.push(msg),
      CONV_ID,
    );

    seedPendingConfirmation(conversationObj, "req-primary");
    seedPendingConfirmation(conversationObj, "req-cascaded");

    registerPendingInteraction(
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );
    registerPendingInteraction(
      conversationObj,
      "req-cascaded",
      CONV_ID,
      makeConfirmationDetails(["bash:echo cascaded"]),
    );

    conversationObj.handleConfirmationResponse("req-primary", "allow_10m");

    const cascadedMsg = emitted.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        (m as unknown as ConfirmationStateChanged).requestId === "req-cascaded",
    ) as unknown as ConfirmationStateChanged;

    expect(cascadedMsg).toBeDefined();
    expect(cascadedMsg.source).toBe("system");
    expect(cascadedMsg.causedByRequestId).toBe("req-primary");
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
      conversationObj,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );
    // Register in pending-interactions but with a request ID that exists
    // in the prompter. We'll remove it from the prompter before cascading
    // reaches it to simulate a stale/already-resolved request.
    registerPendingInteraction(
      conversationObj,
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
      conversationObj.handleConfirmationResponse("req-primary", "allow_10m");
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
