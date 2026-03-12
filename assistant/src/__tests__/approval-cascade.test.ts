/**
 * Tests for cascading approval decisions to matching pending confirmations.
 *
 * When a user resolves one confirmation with a broad decision (allow_10m,
 * allow_thread, always_allow, always_deny), other pending confirmations in
 * the same conversation that match are auto-resolved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

const testDir = mkdtempSync(join(tmpdir(), "approval-cascade-test-"));

// ---------------------------------------------------------------------------
// Mocks — must precede Session import
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

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
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
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    timeouts: { permissionTimeoutSec: 300 },
    apiKeys: {},
    skills: { entries: {}, allowBundled: true },
    memory: { retrieval: { injectionStrategy: "inline" } },
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

mock.module("../skills/slash-commands.js", () => ({
  buildInvocableSlashCatalog: () => new Map(),
  resolveSlashSkillCommand: () => ({ kind: "not_slash" }),
  rewriteKnownSlashCommandPrompt: () => "",
  parseSlashCandidate: () => ({ kind: "not_slash" }),
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
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
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

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      _messages: Message[],
      _onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
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
// Import Session and pendingInteractions AFTER mocks
// ---------------------------------------------------------------------------

import { Session } from "../daemon/session.js";
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

function makeSession(
  sendToClient?: (msg: ServerMessage) => void,
  conversationId = CONV_ID,
): Session {
  return new Session(
    conversationId,
    makeProvider(),
    "system prompt",
    4096,
    sendToClient ?? (() => {}),
    testDir,
  );
}

/**
 * Seed a pending confirmation directly in the prompter's internal map.
 */
function seedPendingConfirmation(session: Session, requestId: string): void {
  const prompter = session["prompter"] as unknown as {
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
  session: Session,
  requestId: string,
  conversationId: string,
  confirmationDetails?: ConfirmationDetails,
): void {
  pendingInteractions.register(requestId, {
    session,
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

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  pendingInteractions.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approval cascading", () => {
  test("allow_10m cascades to all pending in same conversation", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    // Seed 3 pending confirmations
    seedPendingConfirmation(session, "req-1");
    seedPendingConfirmation(session, "req-2");
    seedPendingConfirmation(session, "req-3");

    // Register in pending-interactions tracker
    registerPendingInteraction(
      session,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      session,
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:ls -la"]),
    );
    registerPendingInteraction(
      session,
      "req-3",
      CONV_ID,
      makeConfirmationDetails(["bash:cat file"]),
    );

    // Resolve the first with allow_10m
    session.handleConfirmationResponse("req-1", "allow_10m");

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

  test("allow_thread cascades to all pending in same conversation", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-a");
    seedPendingConfirmation(session, "req-b");
    seedPendingConfirmation(session, "req-c");

    registerPendingInteraction(
      session,
      "req-a",
      CONV_ID,
      makeConfirmationDetails(["bash:echo a"]),
    );
    registerPendingInteraction(
      session,
      "req-b",
      CONV_ID,
      makeConfirmationDetails(["bash:echo b"]),
    );
    registerPendingInteraction(
      session,
      "req-c",
      CONV_ID,
      makeConfirmationDetails(["bash:echo c"]),
    );

    session.handleConfirmationResponse("req-a", "allow_thread");

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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-same");
    seedPendingConfirmation(session, "req-diff");

    // Same conversation
    registerPendingInteraction(
      session,
      "req-same",
      CONV_ID,
      makeConfirmationDetails(["bash:echo same"]),
    );
    // Different conversation
    registerPendingInteraction(
      session,
      "req-diff",
      "different-conv",
      makeConfirmationDetails(["bash:echo diff"]),
    );

    // Seed a primary request
    seedPendingConfirmation(session, "req-primary");
    registerPendingInteraction(
      session,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );

    session.handleConfirmationResponse("req-primary", "allow_10m");

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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    // Two with matching patterns (asset_materialize:doc.pdf)
    seedPendingConfirmation(session, "req-match-1");
    seedPendingConfirmation(session, "req-match-2");
    // One with non-overlapping pattern
    seedPendingConfirmation(session, "req-nomatch");

    registerPendingInteraction(
      session,
      "req-match-1",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:doc.pdf"]),
    );
    registerPendingInteraction(
      session,
      "req-match-2",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:report.pdf"]),
    );
    registerPendingInteraction(
      session,
      "req-nomatch",
      CONV_ID,
      makeConfirmationDetails(["bash:rm -rf"]),
    );

    // Primary request
    seedPendingConfirmation(session, "req-primary");
    registerPendingInteraction(
      session,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:image.png"]),
    );

    session.handleConfirmationResponse(
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

  test("always_deny cascades deny to pattern-matching pending", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-match-1");
    seedPendingConfirmation(session, "req-nomatch");

    registerPendingInteraction(
      session,
      "req-match-1",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:doc.pdf"]),
    );
    registerPendingInteraction(
      session,
      "req-nomatch",
      CONV_ID,
      makeConfirmationDetails(["bash:rm -rf"]),
    );

    seedPendingConfirmation(session, "req-primary");
    registerPendingInteraction(
      session,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["asset_materialize:image.png"]),
    );

    session.handleConfirmationResponse(
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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-1");
    seedPendingConfirmation(session, "req-2");

    registerPendingInteraction(
      session,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      session,
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:echo world"]),
    );

    session.handleConfirmationResponse("req-1", "allow");

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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-1");
    seedPendingConfirmation(session, "req-2");

    registerPendingInteraction(
      session,
      "req-1",
      CONV_ID,
      makeConfirmationDetails(["bash:echo hello"]),
    );
    registerPendingInteraction(
      session,
      "req-2",
      CONV_ID,
      makeConfirmationDetails(["bash:echo world"]),
    );

    session.handleConfirmationResponse("req-1", "deny");

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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-primary");
    seedPendingConfirmation(session, "req-cascaded");

    registerPendingInteraction(
      session,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );
    registerPendingInteraction(
      session,
      "req-cascaded",
      CONV_ID,
      makeConfirmationDetails(["bash:echo cascaded"]),
    );

    session.handleConfirmationResponse("req-primary", "allow_10m");

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
    const session = makeSession((msg) => emitted.push(msg), CONV_ID);

    seedPendingConfirmation(session, "req-primary");
    seedPendingConfirmation(session, "req-stale");

    registerPendingInteraction(
      session,
      "req-primary",
      CONV_ID,
      makeConfirmationDetails(["bash:echo primary"]),
    );
    // Register in pending-interactions but with a request ID that exists
    // in the prompter. We'll remove it from the prompter before cascading
    // reaches it to simulate a stale/already-resolved request.
    registerPendingInteraction(
      session,
      "req-stale",
      CONV_ID,
      makeConfirmationDetails(["bash:echo stale"]),
    );

    // Remove req-stale from the prompter's pending map (simulating it was
    // already resolved by another path before cascade reaches it)
    const prompter = session["prompter"] as unknown as {
      pending: Map<string, unknown>;
    };
    prompter.pending.delete("req-stale");

    // This should not throw — cascade should skip req-stale gracefully
    expect(() => {
      session.handleConfirmationResponse("req-primary", "allow_10m");
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
