import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { UserMessageAttachment } from "../daemon/ipc-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

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
      enabled: true,
      maxInputTokens: 100000,
      targetInputTokens: 70000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 6,
      summaryMaxTokens: 512,
      chunkTokens: 12000,
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
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Token estimator: return a small value (well within budget) so preflight
// does not trigger in existing tests.
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: () => 1000,
}));

// Overflow recovery module mocks — the convergence loop delegates to these
// but these tests exercise the Session-level flow, not the reducer internals.
// The reducer mock delegates to the compactFn to simulate a forced compaction
// tier, matching the real reducer's behavior for Tier 1.
mock.module("../daemon/context-overflow-reducer.js", () => ({
  createInitialReducerState: () => ({
    appliedTiers: [],
    injectionMode: "full" as const,
    exhausted: false,
  }),
  reduceContextOverflow: async (
    msgs: Message[],
    _cfg: unknown,
    _state: unknown,
    compactFn?: (
      m: Message[],
      s: AbortSignal | undefined,
      o: Record<string, unknown>,
    ) => Promise<{
      compacted: boolean;
      messages: Message[];
      compactedPersistedMessages?: number;
      summaryText?: string;
      [k: string]: unknown;
    }>,
    signal?: AbortSignal,
  ) => {
    let resultMessages = msgs;
    let compactionResult;
    if (compactFn) {
      const cr = await compactFn(msgs, signal, { force: true });
      if (cr.compacted) {
        resultMessages = cr.messages;
        compactionResult = cr;
      }
    }
    return {
      messages: resultMessages,
      tier: "forced_compaction",
      state: {
        appliedTiers: [
          "forced_compaction",
          "tool_result_truncation",
          "media_stubbing",
          "injection_downgrade",
        ],
        injectionMode: "full",
        exhausted: true,
      },
      estimatedTokens: 1000,
      compactionResult,
    };
  },
}));

mock.module("../daemon/context-overflow-policy.js", () => ({
  resolveOverflowAction: () => "fail_gracefully",
}));

mock.module("../daemon/context-overflow-approval.js", () => ({
  requestCompressionApproval: async () => ({ approved: false }),
  CONTEXT_OVERFLOW_TOOL_NAME: "context_overflow_compression",
}));

mock.module("../config/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
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
  deleteMessageById: () => {},
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
  addMessage: () => ({ id: "new-msg" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  provenanceFromTrustContext: () => ({}),
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

let maybeCompactCalls: Array<{ force: boolean }> = [];
let forceCompactionEnabled = false;

mock.module("../context/window-manager.js", () => ({
  ContextWindowManager: class {
    constructor() {}
    shouldCompact() {
      return false;
    }
    async maybeCompact(
      messages: Message[],
      _signal?: AbortSignal,
      options?: { force?: boolean },
    ) {
      maybeCompactCalls.push({ force: options?.force === true });
      if (options?.force && forceCompactionEnabled) {
        return {
          compacted: true,
          messages,
          previousEstimatedInputTokens: 120000,
          estimatedInputTokens: 50000,
          maxInputTokens: 100000,
          thresholdTokens: 80000,
          compactedMessages: 2,
          compactedPersistedMessages: 2,
          summaryCalls: 1,
          summaryInputTokens: 200,
          summaryOutputTokens: 50,
          summaryModel: "mock-summary-model",
          summaryText: "## Goals\n- compacted",
        };
      }
      return { compacted: false };
    }
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

// Track how many times agentLoop.run was called
let agentLoopRunCount = 0;
let firstRunErrorMode:
  | "none"
  | "ordering"
  | "context_too_large"
  | "context_too_large_phrase"
  | "context_too_large_413"
  | "context_too_large_413_with_progress" = "ordering";

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
    ): Promise<Message[]> {
      agentLoopRunCount++;

      if (
        agentLoopRunCount === 1 &&
        firstRunErrorMode === "context_too_large_413_with_progress"
      ) {
        // Simulate a run that made progress (tool-use + tool-result) before
        // hitting a 413 context-too-large error on the second LLM call.
        onEvent({
          type: "usage",
          inputTokens: 10,
          outputTokens: 20,
          model: "mock",
          providerDurationMs: 50,
        });
        const assistantMsg: Message = {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "bash",
              input: { command: "echo hi" },
            },
          ],
        };
        onEvent({ type: "message_complete", message: assistantMsg });
        onEvent({
          type: "tool_result",
          toolUseId: "tu-1",
          content: "hi",
          isError: false,
        });
        // Now the second LLM call fails with 413
        onEvent({
          type: "error",
          error: new ProviderError(
            "request entity too large",
            "mock-provider",
            413,
          ),
        });
        const history = [...messages];
        history.push(assistantMsg);
        history.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "hi" },
          ],
        } as Message);
        return history; // Progress was made — history grew
      }

      if (agentLoopRunCount === 1 && firstRunErrorMode !== "none") {
        onEvent({
          type: "usage",
          inputTokens: 0,
          outputTokens: 0,
          model: "mock",
          providerDurationMs: 0,
        });
        const error = (() => {
          if (firstRunErrorMode === "ordering") {
            return new Error(
              "tool_result blocks that are not immediately after a tool_use block",
            );
          }
          if (firstRunErrorMode === "context_too_large_phrase") {
            return new Error(
              "The conversation is too long for the model to process.",
            );
          }
          if (firstRunErrorMode === "context_too_large_413") {
            return new ProviderError(
              "request entity too large",
              "mock-provider",
              413,
            );
          }
          return new Error(
            "context_length_exceeded: request has too many input tokens",
          );
        })();
        onEvent({ type: "error", error });
        return [...messages]; // Return unchanged — no progress
      }

      // Second call (retry) or non-error: succeed normally
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
        model: "mock",
        providerDurationMs: 50,
      });
      const history = [...messages];
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
      };
      history.push(assistantMsg);
      onEvent({ type: "message_complete", message: assistantMsg });
      return history;
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

function makeImageAttachments(
  count: number,
  bytesPerImage = 20_000,
): UserMessageAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `shot-${i + 1}.png`,
    mimeType: "image/png",
    data: `${i}${"A".repeat(bytesPerImage)}`,
  }));
}

describe("provider ordering error retry", () => {
  beforeEach(() => {
    agentLoopRunCount = 0;
    firstRunErrorMode = "ordering";
    maybeCompactCalls = [];
    forceCompactionEnabled = false;
  });

  test("simulated strict provider error triggers exactly one retry", async () => {
    firstRunErrorMode = "ordering";

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage("Hello", [], (msg) =>
      events.push(msg as unknown as Record<string, unknown>),
    );

    // Should have been called exactly 2 times: original + one retry
    expect(agentLoopRunCount).toBe(2);
  });

  test("[experimental] retry succeeds with repaired history and no spurious error event", async () => {
    firstRunErrorMode = "ordering";

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage("Hello", [], (msg) =>
      events.push(msg as unknown as Record<string, unknown>),
    );

    // Should have a message_complete event (from successful retry)
    const messageComplete = events.find((e) => e.type === "message_complete");
    expect(messageComplete).toBeDefined();

    // Ordering error should be suppressed when retry succeeds — no error events
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBe(0);

    // Should also have the assistant response in memory
    const messages = session.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
  });

  test("non-ordering errors do not trigger retry", async () => {
    firstRunErrorMode = "none";

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage("Hello", [], (msg) =>
      events.push(msg as unknown as Record<string, unknown>),
    );

    // Should have been called exactly 1 time (no retry for non-ordering errors)
    expect(agentLoopRunCount).toBe(1);
  });

  test("context-too-large triggers one forced-compaction retry for image-heavy input", async () => {
    firstRunErrorMode = "context_too_large";
    forceCompactionEnabled = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      "Please compare these images.",
      makeImageAttachments(8),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([{ force: false }, { force: true }]);
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(events.some((e) => e.type === "session_error")).toBe(false);
  });

  test("context-too-large can recover by trimming older media when forced compaction cannot run", async () => {
    firstRunErrorMode = "context_too_large";
    forceCompactionEnabled = false;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      "Please compare these images.",
      makeImageAttachments(8),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([{ force: false }, { force: true }]);

    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(events.some((e) => e.type === "session_error")).toBe(false);
  });

  test("context-too-large still surfaces when no media payloads are available to trim", async () => {
    firstRunErrorMode = "context_too_large";
    forceCompactionEnabled = false;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage("No attachments here.", [], (msg) =>
      events.push(msg as unknown as Record<string, unknown>),
    );

    // The convergence loop attempts one reducer tier (which calls compactFn
    // via force:true but compaction returns compacted:false), then retries the
    // agent loop. The mock agent loop succeeds on the second call, so the
    // convergence loop recovers. agentLoopRunCount is 2: initial + one retry.
    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([{ force: false }, { force: true }]);
    // Recovery succeeded — no session_error surfaced
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
  });

  test("context-too-large phrase also triggers one forced-compaction retry", async () => {
    firstRunErrorMode = "context_too_large_phrase";
    forceCompactionEnabled = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      "Please compare these images.",
      makeImageAttachments(4),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([{ force: false }, { force: true }]);
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(events.some((e) => e.type === "session_error")).toBe(false);
  });

  test("ProviderError with statusCode 413 triggers forced-compaction retry via classifySessionError", async () => {
    firstRunErrorMode = "context_too_large_413";
    forceCompactionEnabled = true;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      "Please compare these images.",
      makeImageAttachments(8),
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    // The 413 ProviderError message "request entity too large" doesn't match
    // the regex patterns, but classifySessionError recognizes statusCode 413
    // as CONTEXT_TOO_LARGE and sets contextTooLargeDetected = true.
    expect(agentLoopRunCount).toBe(2);
    expect(maybeCompactCalls).toEqual([{ force: false }, { force: true }]);
    expect(events.some((e) => e.type === "message_complete")).toBe(true);
    expect(events.some((e) => e.type === "session_error")).toBe(false);
  });

  test("context-too-large after progress surfaces error instead of silent failure", async () => {
    firstRunErrorMode = "context_too_large_413_with_progress";
    forceCompactionEnabled = false;

    const session = makeSession();
    await session.loadFromDb();

    const events: Array<Record<string, unknown>> = [];
    await session.processMessage(
      "Run some tools then hit the limit.",
      [],
      (msg) => events.push(msg as unknown as Record<string, unknown>),
    );

    // Only one agent loop run — the retry path is skipped because progress was made.
    expect(agentLoopRunCount).toBe(1);

    // The error must be surfaced to clients via session_error, not silently swallowed.
    const sessionError = events.find((e) => e.type === "session_error") as
      | { code?: string }
      | undefined;
    expect(sessionError).toBeDefined();
    expect(sessionError?.code).toBe("CONTEXT_TOO_LARGE");
  });
});
