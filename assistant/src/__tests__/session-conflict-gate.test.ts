import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

let runCalls: Message[][] = [];
let resolverCallCount = 0;
let conflictScopeCalls: string[] = [];
let memoryEnabled = true;
let resolveConflictCalls: Array<{
  id: string;
  input: { status: string; resolutionNote?: string | null };
}> = [];
let pendingConflicts: Array<{
  id: string;
  scopeId: string;
  existingItemId: string;
  candidateItemId: string;
  relationship: string;
  status: "pending_clarification";
  clarificationQuestion: string | null;
  resolutionNote: string | null;
  lastAskedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  existingStatement: string;
  candidateStatement: string;
  existingKind: string;
  candidateKind: string;
  existingVerificationState: string;
  candidateVerificationState: string;
}> = [];

let resolverResult: {
  resolution: "keep_existing" | "keep_candidate" | "merge" | "still_unclear";
  strategy: "heuristic" | "llm" | "llm_timeout" | "llm_error" | "no_llm_key";
  resolvedStatement: string | null;
  explanation: string;
} = {
  resolution: "still_unclear",
  strategy: "heuristic",
  resolvedStatement: null,
  explanation: "Need user clarification.",
};

const persistedMessages: Array<{
  id: string;
  role: string;
  content: string;
  createdAt: number;
}> = [];

function makeMockLogger(): Record<string, unknown> {
  const logger: Record<string, unknown> = {};
  logger.child = () => logger;
  logger.debug = () => {};
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  return logger;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp",
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
    commitIfDirty: async () => ({ committed: false }),
  }),
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
      enabled: true,
      maxInputTokens: 100000,
      targetBudgetRatio: 0.30,
      compactThreshold: 0.8,      summaryBudgetRatio: 0.05,
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
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
    memory: {
      enabled: memoryEnabled,
      retrieval: {
        injectionStrategy: "prepend_user_block",
        dynamicBudget: {
          enabled: false,
          minInjectTokens: 1200,
          maxInjectTokens: 10000,
          targetHeadroomTokens: 10000,
        },
      },
      embeddings: {
        provider: "auto",
        required: true,
      },
      entity: {
        enabled: false,
      },
      qdrant: {
        url: "http://127.0.0.1:6333",
        collection: "memory",
        vectorSize: 384,
        onDisk: true,
        quantization: "scalar",
      },
      conflicts: {
        enabled: true,
        gateMode: "soft",
        resolverLlmTimeoutMs: 250,
        relevanceThreshold: 0.2,
        conflictableKinds: [
          "preference",
          "profile",
          "constraint",
          "instruction",
          "style",
        ],
      },
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

mock.module("../skills/slash-commands.js", () => ({
  buildInvocableSlashCatalog: () => new Map(),
  resolveSlashSkillCommand: () => ({ kind: "not_slash" }),
  rewriteKnownSlashCommandPrompt: () => "",
  parseSlashCandidate: () => ({ kind: "not_slash" }),
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
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => persistedMessages,
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: (_conversationId: string, role: string, content: string) => {
    const row = {
      id: `msg-${persistedMessages.length + 1}`,
      role,
      content,
      createdAt: Date.now(),
    };
    persistedMessages.push(row);
    return { id: row.id };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], orphanedItemIds: [] }),
  deleteLastExchange: () => 0,
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
    enabled: true,
    degraded: false,
    reason: null,
    provider: "mock",
    model: "mock",
    injectedText: "",
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    entityHits: 0,
    relationSeedEntityCount: 0,
    relationTraversedEdgeCount: 0,
    relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0,
    earlyTerminated: false,
    mergedCount: 0,
    selectedCount: 0,
    rerankApplied: false,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  injectMemoryRecallAsSeparateMessage: (msgs: Message[]) => msgs,
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

mock.module("../memory/conflict-store.js", () => ({
  listPendingConflictDetails: (scopeId: string) => {
    conflictScopeCalls.push(scopeId);
    return pendingConflicts;
  },
  applyConflictResolution: () => true,
  resolveConflict: (
    id: string,
    input: { status: string; resolutionNote?: string | null },
  ) => {
    resolveConflictCalls.push({ id, input });
    // Remove dismissed conflicts so the second listPendingConflictDetails call
    // reflects the dismissal (mirrors real DB behavior).
    if (input.status === "dismissed") {
      const idx = pendingConflicts.findIndex((c) => c.id === id);
      if (idx !== -1) pendingConflicts.splice(idx, 1);
    }
    return null;
  },
}));

mock.module("../memory/clarification-resolver.js", () => ({
  resolveConflictClarification: async () => {
    resolverCallCount += 1;
    return resolverResult;
  },
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

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "usage-1", createdAt: Date.now() }),
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
    ): Promise<Message[]> {
      runCalls.push(messages);
      const assistantMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: "normal assistant answer" }],
      };
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 10,
      });
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

import { Session, type SessionMemoryPolicy } from "../daemon/session.js";
import {
  ConflictGate,
  looksLikeClarificationReply,
} from "../daemon/session-conflict-gate.js";

function makeSession(memoryPolicy?: SessionMemoryPolicy): Session {
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
  const session = new Session(
    "conv-1",
    provider,
    "system prompt",
    4096,
    () => {},
    "/tmp",
    undefined,
    memoryPolicy,
  );
  session.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return session;
}

function extractText(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");
}

describe("Session conflict soft gate (non-interruptive)", () => {
  beforeEach(() => {
    runCalls = [];
    resolverCallCount = 0;
    conflictScopeCalls = [];
    resolveConflictCalls = [];
    memoryEnabled = true;
    pendingConflicts = [];
    persistedMessages.length = 0;
    resolverResult = {
      resolution: "still_unclear",
      strategy: "heuristic",
      resolvedStatement: null,
      explanation: "Need user clarification.",
    };
  });

  test("relevant conflict does not produce user-facing clarification — agent loop runs normally", async () => {
    pendingConflicts = [
      {
        id: "conflict-relevant",
        scopeId: "default",
        existingItemId: "existing-a",
        candidateItemId: "candidate-a",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Do you want React or Vue for frontend work?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use React for frontend work.",
        candidateStatement: "Use Vue for frontend work.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage(
      "Should I use React or Vue here?",
      [],
      (event) => events.push(event),
    );

    // Agent loop runs — no clarification prompt blocks it
    expect(runCalls).toHaveLength(1);
    // No clarification text delta emitted
    const textDeltas = events.filter(
      (event) => event.type === "assistant_text_delta",
    );
    for (const delta of textDeltas) {
      if (delta.type === "assistant_text_delta") {
        expect(delta.text).not.toContain("conflicting");
        expect(delta.text).not.toContain("React or Vue");
      }
    }
    expect(events.some((event) => event.type === "message_complete")).toBe(
      true,
    );
  });

  test("irrelevant conflict does not inject side-question and agent loop runs normally", async () => {
    pendingConflicts = [
      {
        id: "conflict-irrelevant-silent",
        scopeId: "default",
        existingItemId: "existing-b",
        candidateItemId: "candidate-b",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage(
      "How do I set up pre-commit hooks?",
      [],
      (event) => events.push(event),
    );

    // Agent loop runs without conflict side-question injection
    expect(runCalls).toHaveLength(1);
    const injectedUser = runCalls[0][runCalls[0].length - 1];
    expect(injectedUser.role).toBe("user");
    const injectedText = extractText(injectedUser);
    expect(injectedText).not.toContain("Memory clarification request");
    expect(resolverCallCount).toBe(0);
    expect(events.some((event) => event.type === "message_complete")).toBe(
      true,
    );
  });

  // NOTE: "topically relevant explicit clarification reply resolves conflict"
  // was removed — the ConflictGate is no longer wired into the session pipeline
  // (removed in the V2 memory rewrite). The equivalent behavior is covered by
  // the "ConflictGate (unit)" tests below that call gate.evaluate() directly.

  test("non-clarification message does not attempt resolution", async () => {
    pendingConflicts = [
      {
        id: "conflict-no-resolve",
        scopeId: "default",
        existingItemId: "existing-nr",
        candidateItemId: "candidate-nr",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("What's new in Bun?", [], () => {});

    expect(resolverCallCount).toBe(0);
    expect(runCalls).toHaveLength(1);
  });

  test("clarification reply without topical relevance does not resolve conflict", async () => {
    pendingConflicts = [
      {
        id: "conflict-no-overlap",
        scopeId: "default",
        existingItemId: "existing-no",
        candidateItemId: "candidate-no",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    // "keep it" is a clarification reply but has zero topical overlap
    // with Postgres/MySQL conflict statements
    await session.processMessage("keep it", [], () => {});

    expect(resolverCallCount).toBe(0);
    expect(runCalls).toHaveLength(1);
  });

  // NOTE: "passes session scopeId through to conflict store queries"
  // was removed — the ConflictGate is no longer wired into the session pipeline
  // (removed in the V2 memory rewrite). Scope passing is covered by the unit tests.

  test('default session uses "default" scopeId for conflict queries', async () => {
    pendingConflicts = [];

    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("hello", [], () => {});

    // With no custom policy, scopeId should default to 'default'
    expect(conflictScopeCalls.every((s) => s === "default")).toBe(true);
  });

  test("skips conflict gate when top-level memory.enabled is false", async () => {
    memoryEnabled = false;
    pendingConflicts = [
      {
        id: "conflict-disabled",
        scopeId: "default",
        existingItemId: "existing-d",
        candidateItemId: "candidate-d",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Do you want React or Vue for frontend work?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use React for frontend work.",
        candidateStatement: "Use Vue for frontend work.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage(
      "Should I use React or Vue here?",
      [],
      (event) => events.push(event),
    );

    // Agent loop should run normally — conflict gate should be bypassed
    expect(runCalls).toHaveLength(1);
    expect(resolverCallCount).toBe(0);
  });

  // NOTE: "pending transient conflict is dismissed and not resolved"
  // was removed — the ConflictGate is no longer wired into the session pipeline
  // (removed in the V2 memory rewrite). Dismissal logic is covered by unit tests.

  // NOTE: "incoherent conflict (zero statement overlap) is dismissed"
  // was removed — the ConflictGate is no longer wired into the session pipeline
  // (removed in the V2 memory rewrite). Incoherence dismissal is covered by unit tests.

  // NOTE: "non-user-evidenced conflict (assistant-inferred only) is dismissed"
  // was removed — the ConflictGate is no longer wired into the session pipeline
  // (removed in the V2 memory rewrite). Provenance dismissal is covered by unit tests.

  test("user-evidenced conflict is not dismissed when one side has user provenance", async () => {
    pendingConflicts = [
      {
        id: "conflict-user-evidenced",
        scopeId: "default",
        existingItemId: "existing-ue",
        candidateItemId: "candidate-ue",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Do you want React or Vue?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use React for frontend work.",
        candidateStatement: "Use Vue for frontend work.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "assistant_inferred",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("Should I use React or Vue?", [], () => {});

    // Agent loop runs normally (no blocking)
    expect(runCalls).toHaveLength(1);
    // Conflict should NOT be dismissed — has user-evidenced provenance
    expect(resolveConflictCalls).toEqual([]);
  });

  test("regression: OAuth/Gmail-style conflicting statements with command request produces no clarification", async () => {
    pendingConflicts = [
      {
        id: "conflict-oauth-gmail",
        scopeId: "default",
        existingItemId: "existing-oauth",
        candidateItemId: "candidate-oauth",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion:
          "Which OAuth provider should be the default for email integration?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement:
          "Gmail OAuth is the default email integration provider.",
        candidateStatement:
          "Microsoft OAuth is the default email integration provider.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    // A command request that is unrelated to the conflict
    await session.processMessage(
      "Set up a new Slack channel for the team",
      [],
      (event) => events.push(event),
    );

    // Agent loop runs — no clarification prompt produced
    expect(runCalls).toHaveLength(1);
    expect(resolverCallCount).toBe(0);
    // No clarification text in any event
    for (const event of events) {
      if (event.type === "assistant_text_delta") {
        expect(event.text).not.toContain("OAuth");
        expect(event.text).not.toContain("Gmail");
        expect(event.text).not.toContain("conflicting");
      }
    }
    // Conflict should NOT be dismissed (it's user-evidenced and actionable)
    expect(resolveConflictCalls).toEqual([]);
    expect(events.some((event) => event.type === "message_complete")).toBe(
      true,
    );
  });
});

describe("looksLikeClarificationReply", () => {
  test("accepts action + direction combo", () => {
    expect(looksLikeClarificationReply("keep the new one")).toBe(true);
    expect(looksLikeClarificationReply("use the existing")).toBe(true);
    expect(looksLikeClarificationReply("go with option A")).toBe(true);
  });

  test("accepts directional-only replies", () => {
    expect(looksLikeClarificationReply("both")).toBe(true);
    expect(looksLikeClarificationReply("option B")).toBe(true);
    expect(looksLikeClarificationReply("new one")).toBe(true);
    expect(looksLikeClarificationReply("the existing one")).toBe(true);
    expect(looksLikeClarificationReply("merge them")).toBe(true);
  });

  test("accepts action-only replies", () => {
    expect(looksLikeClarificationReply("keep it")).toBe(true);
    expect(looksLikeClarificationReply("use that")).toBe(true);
  });

  test("rejects questions with question mark", () => {
    expect(looksLikeClarificationReply("what's new in Bun?")).toBe(false);
    expect(looksLikeClarificationReply("which option?")).toBe(false);
  });

  test("rejects questions without question mark", () => {
    expect(looksLikeClarificationReply("what's new in Bun")).toBe(false);
    expect(looksLikeClarificationReply("how do I use option A")).toBe(false);
    expect(looksLikeClarificationReply("where is the new config")).toBe(false);
  });

  test("rejects questions with Unicode smart/curly apostrophes", () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK (common on macOS/iOS keyboards)
    expect(looksLikeClarificationReply("what\u2019s new in Bun")).toBe(false);
    expect(looksLikeClarificationReply("where\u2019s the new config")).toBe(
      false,
    );
    // U+2018 LEFT SINGLE QUOTATION MARK
    expect(looksLikeClarificationReply("who\u2018s option")).toBe(false);
  });

  test("accepts words that share a question-word prefix but are not questions", () => {
    // "whichever" starts with "which", "however" starts with "how", etc.
    // These should NOT be rejected by the question-word gate.
    expect(looksLikeClarificationReply("whichever option")).toBe(true);
    expect(looksLikeClarificationReply("however you want")).toBe(true);
  });

  test("rejects longer direction-only messages (false-positive prevention)", () => {
    // These contain directional cues but no action verb and are > 4 words,
    // so they are likely unrelated statements, not clarification replies.
    expect(looksLikeClarificationReply("try the old approach instead")).toBe(
      false,
    );
    expect(looksLikeClarificationReply("I started a new project today")).toBe(
      false,
    );
    expect(
      looksLikeClarificationReply("check out the latest release notes"),
    ).toBe(false);
  });

  test("rejects long statements", () => {
    expect(
      looksLikeClarificationReply(
        "I was thinking about this and I believe we should keep the new one because it is better",
      ),
    ).toBe(false);
  });

  test("rejects messages with no cue words", () => {
    expect(looksLikeClarificationReply("hello world")).toBe(false);
    expect(looksLikeClarificationReply("sounds good")).toBe(false);
  });
});

describe("ConflictGate (unit)", () => {
  const baseConfig = {
    enabled: true,
    gateMode: "soft" as const,
    relevanceThreshold: 0.2,
    resolverLlmTimeoutMs: 250,
    conflictableKinds: [
      "preference",
      "profile",
      "constraint",
      "instruction",
      "style",
    ] as readonly string[],
  };

  beforeEach(() => {
    pendingConflicts = [];
    resolveConflictCalls = [];
    resolverCallCount = 0;
    conflictScopeCalls = [];
    resolverResult = {
      resolution: "still_unclear",
      strategy: "heuristic",
      resolvedStatement: null,
      explanation: "Need user clarification.",
    };
  });

  test("evaluate returns void (never produces user-facing output)", async () => {
    pendingConflicts = [
      {
        id: "conflict-void",
        scopeId: "default",
        existingItemId: "existing-void",
        candidateItemId: "candidate-void",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Do you want React or Vue?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use React for frontend work.",
        candidateStatement: "Use Vue for frontend work.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const gate = new ConflictGate();
    const result = await gate.evaluate(
      "Should I use React or Vue here?",
      baseConfig,
    );

    expect(result).toBeUndefined();
  });

  test("dismisses assistant-inferred-only conflicts via provenance check", async () => {
    pendingConflicts = [
      {
        id: "conflict-inferred-only",
        scopeId: "default",
        existingItemId: "existing-inf",
        candidateItemId: "candidate-inf",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "assistant_inferred",
        candidateVerificationState: "assistant_inferred",
      },
    ];

    const gate = new ConflictGate();
    await gate.evaluate("anything", baseConfig);

    expect(resolveConflictCalls).toEqual([
      {
        id: "conflict-inferred-only",
        input: {
          status: "dismissed",
          resolutionNote:
            "Dismissed by conflict policy (no user-evidenced provenance).",
        },
      },
    ]);
  });

  test("keeps user-evidenced conflict actionable", async () => {
    pendingConflicts = [
      {
        id: "conflict-ue",
        scopeId: "default",
        existingItemId: "existing-ue2",
        candidateItemId: "candidate-ue2",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_confirmed",
        candidateVerificationState: "assistant_inferred",
      },
    ];

    const gate = new ConflictGate();
    await gate.evaluate("anything", baseConfig);

    // No dismissal for user-evidenced conflicts
    expect(resolveConflictCalls).toEqual([]);
  });

  test("explicit clarification with topical relevance triggers resolver", async () => {
    pendingConflicts = [
      {
        id: "conflict-resolve-unit",
        scopeId: "default",
        existingItemId: "existing-ru",
        candidateItemId: "candidate-ru",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    resolverResult = {
      resolution: "keep_existing",
      strategy: "heuristic",
      resolvedStatement: null,
      explanation: "User prefers Postgres.",
    };

    const gate = new ConflictGate();
    // "use Postgres" has action cue "use" and topical overlap with "Postgres"
    await gate.evaluate("use Postgres", baseConfig);

    expect(resolverCallCount).toBe(1);
  });

  test("clarification reply without topical relevance does not trigger resolver", async () => {
    pendingConflicts = [
      {
        id: "conflict-no-rel",
        scopeId: "default",
        existingItemId: "existing-nrel",
        candidateItemId: "candidate-nrel",
        relationship: "ambiguous_contradiction",
        status: "pending_clarification",
        clarificationQuestion: "Should I assume Postgres or MySQL?",
        resolutionNote: null,
        lastAskedAt: null,
        resolvedAt: null,
        createdAt: 1,
        updatedAt: 1,
        existingStatement: "Use Postgres as the default database.",
        candidateStatement: "Use MySQL as the default database.",
        existingKind: "preference",
        candidateKind: "preference",
        existingVerificationState: "user_reported",
        candidateVerificationState: "user_reported",
      },
    ];

    const gate = new ConflictGate();
    // "keep it" looks like clarification but has no topical overlap
    await gate.evaluate("keep it", baseConfig);

    expect(resolverCallCount).toBe(0);
  });
});
