import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type {
  AgentEvent,
  AgentLoopRunResult,
  CheckpointDecision,
  CheckpointInfo,
  ExitReason,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Conversation import so Bun applies them at load time.
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

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
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
    memory: {
      v2: { enabled: false },
      retrieval: { scratchpadInjection: { enabled: true } },
    },
    conversations: { skipAutoRetitling: false },
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
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
        provider: "anthropic",
        model: "claude-opus-4-6",
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

const capturedAddMessages: Array<{
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> = [];

/**
 * Content substrings that should cause `addMessage` to throw — used to
 * simulate a mid-batch persist failure (e.g. a DB error on a specific
 * tail message while its siblings succeed).
 */
const addMessageShouldThrowForContent = new Set<string>();

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
  patternMatchesCandidate: () => false,
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

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
  addMessage: (
    _convId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    // Simulate a persist failure for tests that need to exercise the
    // tail-persist-failed path in drainBatch. Triggered by matching any
    // registered substring against the serialized content payload.
    for (const needle of addMessageShouldThrowForContent) {
      if (content.includes(needle)) {
        throw new Error(`Simulated addMessage failure for content: ${needle}`);
      }
    }
    const id = `msg-${Date.now()}-${capturedAddMessages.length}`;
    capturedAddMessages.push({
      id,
      role,
      content,
      metadata: options?.metadata,
    });
    return { id };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  updateMessageContent: mock(() => {}),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

let linkAttachmentShouldThrow = false;
let mockAttachmentIdCounter = 0;

mock.module("../persistence/attachments-store.js", () => ({
  AttachmentUploadError: class AttachmentUploadError extends Error {},
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {
    if (linkAttachmentShouldThrow) {
      throw new Error("Simulated linkAttachmentToMessage failure");
    }
  },
  attachInlineAttachmentToMessage: (
    _messageId: string,
    _position: number,
    filename: string,
    mimeType: string,
    dataBase64: string,
  ) => {
    if (linkAttachmentShouldThrow) {
      throw new Error("Simulated linkAttachmentToMessage failure");
    }

    return {
      id: `att-inline-${++mockAttachmentIdCounter}`,
      originalFilename: filename,
      mimeType,
      sizeBytes: Buffer.from(dataBase64, "base64").byteLength,
      kind: mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : "file",
      thumbnailBase64: null,
      createdAt: Date.now(),
    };
  },
  getFilePathForAttachment: () => null,
  setAttachmentThumbnail: () => {},
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

// ---------------------------------------------------------------------------
// Workspace/git turn-commit test hooks.
// ---------------------------------------------------------------------------

const turnCommitCalls: Array<{
  workspaceDir: string;
  conversationId: string;
  turnNumber: number;
}> = [];
let turnCommitHangForever = false;

// ---------------------------------------------------------------------------
// Usage event capture for request-ID correlation tests.
// ---------------------------------------------------------------------------

interface CapturedUsageEvent {
  requestId: string | null;
  actor: string;
}

let capturedUsageEvents: CapturedUsageEvent[] = [];

mock.module("../persistence/llm-usage-store.js", () => ({
  recordUsageEvent: (input: { requestId: string | null; actor: string }) => {
    capturedUsageEvents.push({
      requestId: input.requestId,
      actor: input.actor,
    });
    return { id: "mock-id", createdAt: Date.now(), ...input };
  },
  listUsageEvents: () => [],
}));

// ---------------------------------------------------------------------------
// Controllable AgentLoop mock.
//
// Each `run()` call returns a promise that does NOT resolve until the test
// explicitly calls the stored `resolve` callback. This lets us simulate a
// long-running agent loop so we can enqueue messages while the first one is
// still "processing".
// ---------------------------------------------------------------------------

interface PendingRun {
  resolve: (history: Message[]) => void;
  reject: (err: Error) => void;
  messages: Message[];
  onEvent: (event: AgentEvent) => void | Promise<void>;
  onCheckpoint?: (
    checkpoint: CheckpointInfo,
  ) => CheckpointDecision | Promise<CheckpointDecision>;
  /**
   * Pause-reason recorded from the most recent `onCheckpoint` call, mirroring
   * how the production loop carries it back via {@link AgentLoopRunResult}.
   * `resolve(history)` packages this into the run result so the orchestrator
   * derives its handoff bookkeeping the same way it does against the real loop.
   */
  exitReason: ExitReason | null;
}

let pendingRuns: PendingRun[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
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
    async run(options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void | Promise<void>;
      onCheckpoint?: (
        checkpoint: CheckpointInfo,
      ) => CheckpointDecision | Promise<CheckpointDecision>;
    }): Promise<AgentLoopRunResult> {
      const { messages, onEvent } = options;
      return new Promise<AgentLoopRunResult>((resolveResult, reject) => {
        const pending: PendingRun = {
          resolve: (history: Message[]) =>
            resolveResult({
              history,
              exitReason: pending.exitReason,
              newMessages: history.slice(messages.length),
            }),
          reject,
          messages,
          onEvent,
          exitReason: null,
          onCheckpoint: options?.onCheckpoint
            ? async (checkpoint) => {
                const decision = await options.onCheckpoint!(checkpoint);
                pending.exitReason = decision === "continue" ? null : decision;
                return decision;
              }
            : undefined,
        };
        pendingRuns.push(pending);
      });
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
// Import Conversation AFTER mocks are registered.
// ---------------------------------------------------------------------------

import type { QueueDrainReason, QueuePolicy } from "../daemon/conversation.js";
import { Conversation } from "../daemon/conversation.js";
import { MessageQueue } from "../daemon/conversation-queue-manager.js";

type ConversationWithWorkspaceDeps = Conversation & {
  getWorkspaceGitService?: (_workspaceDir: string) => {
    ensureInitialized: () => Promise<void>;
  };
  commitTurnChanges?: (
    workspaceDir: string,
    conversationId: string,
    turnNumber: number,
    provider?: unknown,
    deadlineMs?: number,
  ) => Promise<void>;
};

function makeConversation(
  sendToClient?: (msg: ServerMessage) => void,
): Conversation {
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
  const conversationObj = new Conversation(
    "conv-1",
    provider,
    "system prompt",
    sendToClient ?? (() => {}),
    "/tmp",
    { maxTokens: 4096 },
  );
  const conversationWithWorkspaceDeps =
    conversationObj as ConversationWithWorkspaceDeps;
  conversationWithWorkspaceDeps.getWorkspaceGitService = () => ({
    ensureInitialized: async () => {},
  });
  conversationWithWorkspaceDeps.commitTurnChanges = async (
    workspaceDir: string,
    conversationId: string,
    turnNumber: number,
  ) => {
    turnCommitCalls.push({ workspaceDir, conversationId, turnNumber });
    if (turnCommitHangForever) {
      // Simulate a commit that never resolves within the timeout budget
      await new Promise<void>(() => {});
    }
  };
  return conversationObj;
}

/**
 * Wait until the pending runs array has at least `count` entries.
 * This is needed because `processMessage` is async and goes through
 * several awaited steps (context compaction, memory recall) before
 * reaching `agentLoop.run()`.
 */
async function waitForPendingRun(
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (pendingRuns.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${count} pending runs (have ${pendingRuns.length})`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Resolve the Nth pending AgentLoop.run() call. Fires the minimal events
 * that `runAgentLoop` expects (usage + message_complete) so the conversation
 * cleanly transitions out of its processing state.
 */
async function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  // Emit the events runAgentLoop expects
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: `reply-${index}` }],
  };
  // Prime the assistant row anchor — production code emits this from
  // `AgentLoop.run` just before `provider.sendMessage`.
  await run.onEvent({ type: "llm_call_started" });
  await run.onEvent({
    type: "usage",
    inputTokens: 10,
    outputTokens: 5,
    model: "mock",
    providerDurationMs: 100,
  });
  await run.onEvent({ type: "message_complete", message: assistantMsg });
  // Return updated history with the assistant message appended
  run.resolve([...run.messages, assistantMsg]);
}

beforeEach(() => {
  turnCommitCalls.length = 0;
  turnCommitHangForever = false;
  linkAttachmentShouldThrow = false;
  addMessageShouldThrowForContent.clear();
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation message queue", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("second message is queued when conversation is busy (does not throw)", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start first message — this will block on AgentLoop.run
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });

    // Wait for the first AgentLoop.run to be registered
    await waitForPendingRun(1);

    // Conversation should now be processing
    expect(conversation.isProcessing()).toBe(true);

    // Enqueue second message — should NOT throw
    const result = conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    expect(result.queued).toBe(true);
    expect(result.requestId).toBe("req-2");
    expect(conversation.getQueueDepth()).toBe(1);

    // Complete the first message
    await resolveRun(0);
    await p1;

    // After the first run resolves, the queue drains and triggers a second run.
    await waitForPendingRun(2);

    // The dequeued event should have been sent to events2
    expect(events2.some((e) => e.type === "message_dequeued")).toBe(true);

    // A second AgentLoop.run should now be pending
    expect(pendingRuns.length).toBe(2);

    // Complete the second run
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("[experimental] queued passthrough siblings drain as a single batched run", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue two more sibling passthrough messages
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete run 0 → drain pulls msg-2 and msg-3 into ONE batched run.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Exactly two runs total (not three): run 0 = msg-1, run 1 = batched [msg-2, msg-3]
    expect(pendingRuns.length).toBe(2);

    // Each batched client saw its own message_dequeued tagged with its own requestId.
    const dequeued2 = events2.filter((e) => e.type === "message_dequeued");
    expect(dequeued2).toHaveLength(1);
    expect(dequeued2[0]).toEqual({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-2",
    });
    const dequeued3 = events3.filter((e) => e.type === "message_dequeued");
    expect(dequeued3).toHaveLength(1);
    expect(dequeued3[0]).toEqual({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-3",
    });

    // The batched run's captured history carries both siblings. Either as
    // separate user entries (raw history) or merged into one user entry
    // (after history-repair's alternation enforcement — required by the
    // Anthropic API). Either way, both msg-2 and msg-3 text must appear.
    const batchedHistory = pendingRuns[1].messages;
    const userMessages = batchedHistory.filter((m) => m.role === "user");
    const textOf = (m: Message) =>
      (Array.isArray(m.content) ? m.content : [])
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
    const combinedUserText = userMessages.map(textOf).join("\n");
    expect(combinedUserText).toContain("msg-2");
    expect(combinedUserText).toContain("msg-3");

    // Resolve the batched run; message_complete must fan out to both clients.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    expect(events2.some((e) => e.type === "message_complete")).toBe(true);
    expect(events3.some((e) => e.type === "message_complete")).toBe(true);
  });

  test("[experimental] queued passthrough siblings from different client OS do NOT batch", async () => {
    // Post-decouple, web/iOS/macOS all report interfaceId "web", so the
    // interface-based batch split no longer separates them. A batched turn
    // applies only the head's clientOs, so messages from different OS surfaces
    // must split into separate runs rather than coalesce under one OS.
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: () => {},
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Two siblings on the same transport interface ("web") but different OS.
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: () => {},
      requestId: "req-2",
      transport: { channelId: "vellum", interfaceId: "web", clientOs: "macos" },
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: () => {},
      requestId: "req-3",
      transport: { channelId: "vellum", interfaceId: "web", clientOs: "ios" },
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Drain: msg-2 (macos) is the batch head; msg-3 (ios) has a different
    // clientOs, so it must NOT join the batch.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);
    await resolveRun(1);
    await waitForPendingRun(3);

    // Three runs total (msg-1, msg-2, msg-3) — msg-3 was not batched with msg-2.
    expect(pendingRuns.length).toBe(3);
  });

  test("message_queued and message_dequeued events are emitted", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events2: ServerMessage[] = [];

    // Start first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue second — simulating what handleUserMessage does
    const result = conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    expect(result.queued).toBe(true);

    // Complete first
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Check for message_dequeued with correct fields
    const dequeued = events2.find((e) => e.type === "message_dequeued");
    expect(dequeued).toBeDefined();
    expect(dequeued).toEqual({
      type: "message_dequeued",
      conversationId: "conv-1",
      requestId: "req-2",
    });

    // Complete second run so the conversation finishes cleanly
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("abort() clears the queue and sends generation_cancelled for each queued message", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue two more
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Abort
    conversation.abort();

    // Queue should be empty
    expect(conversation.getQueueDepth()).toBe(0);

    // Both queued messages should receive conversation-scoped cancellation events.
    const cancel2 = events2.find((e) => e.type === "generation_cancelled");
    expect(cancel2).toEqual({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });

    const cancel3 = events3.find((e) => e.type === "generation_cancelled");
    expect(cancel3).toEqual({
      type: "generation_cancelled",
      conversationId: "conv-1",
    });

    // abort() must NOT emit conversation_error or generic error for queued discards.
    const err2 = events2.find((e) => e.type === "error");
    expect(err2).toBeUndefined();
    const err3 = events3.find((e) => e.type === "error");
    expect(err3).toBeUndefined();

    const conversationErr2 = events2.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationErr2).toBeUndefined();

    const conversationErr3 = events3.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationErr3).toBeUndefined();

    // Settle the aborted in-flight run so its abort watchdog clears the
    // real-time timer it armed. A leaked ~5s timer otherwise fires during a
    // later test and drives this stale turn into commitTurnChanges, inflating
    // the shared turnCommitCalls counter that other tests assert against.
    await resolveRun(0);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("conversation-scoped errors emit both conversation_error and generic error", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events: ServerMessage[] = [];

    // Start a message — blocks on AgentLoop.run
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Reject the AgentLoop.run() with a provider error to trigger the
    // runAgentLoop catch block
    pendingRuns[0].reject(new Error("Provider returned 500"));
    await p1;

    // Should emit conversation_error (typed, structured)
    const conversationErr = events.find((e) => e.type === "conversation_error");
    expect(conversationErr).toBeDefined();

    // Should also emit generic error (callers rely on error events to detect failures)
    const genericErr = events.find((e) => e.type === "error");
    expect(genericErr).toBeDefined();
  });

  test("queue depth is reported correctly as messages are added and drained", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    expect(conversation.getQueueDepth()).toBe(0);

    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });
    expect(conversation.getQueueDepth()).toBe(1);

    conversation.enqueueMessage({ content: "msg-3", requestId: "req-3" });
    expect(conversation.getQueueDepth()).toBe(2);

    conversation.enqueueMessage({ content: "msg-4", requestId: "req-4" });
    expect(conversation.getQueueDepth()).toBe(3);

    // Complete first → drain pulls all three same-interface passthroughs
    // into a single batched run (depth → 0, runs → 2 total).
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(conversation.getQueueDepth()).toBe(0);
    expect(pendingRuns.length).toBe(2);

    // Complete the batched run; conversation finishes cleanly.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("[experimental] drain continues after a queued message fails to persist", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on AgentLoop.run
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a message with empty content (will fail persistUserMessage)
    conversation.enqueueMessage({
      content: "",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    // Enqueue a valid message after the bad one
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete first message — triggers drain. The empty message should fail
    // to persist, but the drain should continue to msg-3.
    await resolveRun(0);
    await p1;

    // msg-3 should have been dequeued and started a new AgentLoop.run
    await waitForPendingRun(2);

    // The empty message should have received an error event
    const err2 = events2.find((e) => e.type === "error");
    expect(err2).toBeDefined();
    if (err2 && err2.type === "error") {
      expect(err2.message).toContain("required");
    }

    // msg-3 should have received a dequeued event
    expect(events3.some((e) => e.type === "message_dequeued")).toBe(true);

    // Complete the third message's run
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    // msg-3 should have completed successfully
    expect(events3.some((e) => e.type === "message_complete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batched drain — mixed-interface, slash-in-middle, attachments, byte budget
// ---------------------------------------------------------------------------

describe("Batched drain", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("mixed-interface queue splits into multiple batches at each interface boundary", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];
    const events5: ServerMessage[] = [];

    // Start in-flight message (msg-1)
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue 4 messages with interfaces [macos, macos, cli, macos].
    // Expected drain: [macos batch of 2] → [cli single] → [macos single].
    const meta = (iface: string) => ({
      userMessageInterface: iface,
      assistantMessageInterface: iface,
    });
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
      metadata: meta("macos"),
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
      metadata: meta("macos"),
    });
    conversation.enqueueMessage({
      content: "msg-4",
      onEvent: (e) => events4.push(e),
      requestId: "req-4",
      metadata: meta("cli"),
    });
    conversation.enqueueMessage({
      content: "msg-5",
      onEvent: (e) => events5.push(e),
      requestId: "req-5",
      metadata: meta("macos"),
    });
    expect(conversation.getQueueDepth()).toBe(4);

    // Resolve msg-1 → batched run pulls macos msg-2 + msg-3.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Batched run's history must contain both macos messages (either as
    // separate user entries or merged into one after history-repair).
    const macosBatchedHistory = pendingRuns[1].messages;
    const macosUserMessages = macosBatchedHistory.filter(
      (m) => m.role === "user",
    );
    const textOf = (m: Message) =>
      (Array.isArray(m.content) ? m.content : [])
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
    const combinedMacosText = macosUserMessages.map(textOf).join("\n");
    expect(combinedMacosText).toContain("msg-2");
    expect(combinedMacosText).toContain("msg-3");

    // Both msg-2 and msg-3 received their own dequeue event.
    expect(events2.filter((e) => e.type === "message_dequeued")).toHaveLength(
      1,
    );
    expect(events3.filter((e) => e.type === "message_dequeued")).toHaveLength(
      1,
    );

    // Resolve the batched run → drain pulls the cli single-message run.
    await resolveRun(1);
    await waitForPendingRun(3);

    // cli run contains msg-4 as a single-message run.
    const cliHistory = pendingRuns[2].messages;
    const cliUserText = cliHistory
      .filter((m) => m.role === "user")
      .map(textOf)
      .join("\n");
    expect(cliUserText).toContain("msg-4");
    expect(events4.filter((e) => e.type === "message_dequeued")).toHaveLength(
      1,
    );

    // Resolve the cli run → drain pulls the final macos single-message run.
    await resolveRun(2);
    await waitForPendingRun(4);
    const finalHistory = pendingRuns[3].messages;
    const finalUserText = finalHistory
      .filter((m) => m.role === "user")
      .map(textOf)
      .join("\n");
    expect(finalUserText).toContain("msg-5");
    expect(events5.filter((e) => e.type === "message_dequeued")).toHaveLength(
      1,
    );

    // Four total runs: msg-1, batched [msg-2, msg-3], msg-4, msg-5.
    expect(pendingRuns.length).toBe(4);

    await resolveRun(3);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("slash-in-middle splits the queue at the slash boundary", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsHello: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];
    const eventsWorld: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue ["hello", "/compact", "world"]. /compact resolves to a non-
    // passthrough slash, so the batch builder stops at "hello" (length 1),
    // then /compact takes the single-message /compact short-circuit path
    // (no new runAgentLoop invocation), then "world" drains as its own run.
    conversation.enqueueMessage({
      content: "hello",
      onEvent: (e) => eventsHello.push(e),
      requestId: "req-hello",
    });
    conversation.enqueueMessage({
      content: "/compact",
      onEvent: (e) => eventsSlash.push(e),
      requestId: "req-slash",
    });
    conversation.enqueueMessage({
      content: "world",
      onEvent: (e) => eventsWorld.push(e),
      requestId: "req-world",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls "hello" as its own run (batch stops at
    // /compact boundary).
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(pendingRuns.length).toBe(2);
    expect(eventsHello.some((e) => e.type === "message_dequeued")).toBe(true);
    // /compact and "world" are still queued.
    expect(conversation.getQueueDepth()).toBe(2);

    // Resolve "hello" → drain pops /compact via the builder-rejected path,
    // runs its short-circuit (no new runAgentLoop), then drains "world".
    await resolveRun(1);
    await waitForPendingRun(3);

    // /compact should have emitted its own message_complete via the short-
    // circuit path (not via a runAgentLoop run).
    expect(eventsSlash.some((e) => e.type === "message_complete")).toBe(true);
    expect(eventsWorld.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(pendingRuns.length).toBe(3);

    await resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("unknown-slash in middle splits the queue at the unknown-slash boundary", async () => {
    // Covers the `kind: "unknown"` short-circuit branch in drainSingleMessage
    // specifically. The sibling /compact-in-middle test covers the `kind:
    // "compact"` short-circuit (via a different code path), so this test
    // exists to guarantee the batch builder also stops at unknown-kind
    // boundaries and that the unknown-slash drain path does NOT invoke a new
    // runAgentLoop run.
    //
    // We use `/status`, which the real `resolveSlash` returns as
    // `{ kind: "unknown", message: <status report> }` when a SlashContext is
    // present (always true for queued drains via buildSlashContext).
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsPlainA: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];
    const eventsPlainB: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue ["plain-a", "/status", "plain-b"]. /status resolves to a non-
    // passthrough slash (kind: "unknown"), so the batch builder stops at
    // "plain-a" (length-1 batch → drainSingleMessage), then /status takes the
    // unknown-slash short-circuit path (no new runAgentLoop invocation — it
    // emits assistant_text_delta + message_complete inline), then "plain-b"
    // drains as its own run.
    conversation.enqueueMessage({
      content: "plain-a",
      onEvent: (e) => eventsPlainA.push(e),
      requestId: "req-plain-a",
    });
    conversation.enqueueMessage({
      content: "/status",
      onEvent: (e) => eventsSlash.push(e),
      requestId: "req-slash",
    });
    conversation.enqueueMessage({
      content: "plain-b",
      onEvent: (e) => eventsPlainB.push(e),
      requestId: "req-plain-b",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls "plain-a" as its own run (batch stops at
    // the /status boundary).
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(pendingRuns.length).toBe(2);
    expect(eventsPlainA.some((e) => e.type === "message_dequeued")).toBe(true);
    // /status and "plain-b" are still queued.
    expect(conversation.getQueueDepth()).toBe(2);

    // Resolve "plain-a" → drain pops /status via the builder-rejected path,
    // runs its unknown-slash short-circuit (no new runAgentLoop, emits
    // assistant_text_delta + message_complete inline), then drains "plain-b"
    // as its own run.
    await resolveRun(1);
    await waitForPendingRun(3);

    // /status should have emitted its own assistant_text_delta + message_complete
    // via the unknown-slash short-circuit path (not via a runAgentLoop run).
    expect(eventsSlash.some((e) => e.type === "assistant_text_delta")).toBe(
      true,
    );
    expect(eventsSlash.some((e) => e.type === "message_complete")).toBe(true);
    expect(eventsPlainB.some((e) => e.type === "message_dequeued")).toBe(true);
    // Only three runs total: msg-1, "plain-a", "plain-b". /status short-circuits
    // without a runAgentLoop invocation.
    expect(pendingRuns.length).toBe(3);

    await resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("attachments are preserved across a batched drain", async () => {
    capturedAddMessages.length = 0;
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Two sibling messages, each with a distinct image attachment.
    const attachA = [
      {
        id: "att-a",
        filename: "a.png",
        mimeType: "image/png",
        data: Buffer.from("imageA").toString("base64"),
        filePath: "/tmp/a.png",
      },
    ];
    const attachB = [
      {
        id: "att-b",
        filename: "b.png",
        mimeType: "image/png",
        data: Buffer.from("imageB").toString("base64"),
        filePath: "/tmp/b.png",
      },
    ];
    conversation.enqueueMessage({
      content: "with-A",
      attachments: attachA,
      requestId: "req-A",
    });
    conversation.enqueueMessage({
      content: "with-B",
      attachments: attachB,
      requestId: "req-B",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Two persisted user rows in the DB (one per batched message), each with
    // its own imageSourcePaths metadata keyed by the right filename.
    const userRows = capturedAddMessages.filter(
      (m) => m.role === "user" && m.content.includes('"image"'),
    );
    expect(userRows).toHaveLength(2);
    const pathsA = (userRows[0].metadata as Record<string, unknown>)
      ?.imageSourcePaths as Record<string, string> | undefined;
    expect(pathsA).toBeDefined();
    expect(pathsA!["0:a.png"]).toBe("/tmp/a.png");
    const pathsB = (userRows[1].metadata as Record<string, unknown>)
      ?.imageSourcePaths as Record<string, string> | undefined;
    expect(pathsB).toBeDefined();
    expect(pathsB!["0:b.png"]).toBe("/tmp/b.png");

    // The batched run's in-memory history also reflects both image sources
    // (enrichMessageWithSourcePaths injects file:// references for images).
    const batchedHistory = pendingRuns[1].messages;
    const userMessages = batchedHistory.filter((m) => m.role === "user");
    const allText = userMessages
      .map((m) =>
        (Array.isArray(m.content) ? m.content : [])
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n"),
      )
      .join("\n");
    expect(allText).toContain("a.png");
    expect(allText).toContain("b.png");

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("byte-budget accounting is unchanged by shiftN-based batching", async () => {
    // Uses a small budget so we can observe reclamation after drain.
    // Each ~500-char message ≈ 1512 bytes.
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const budget = 4000;
    (
      conversation as unknown as {
        queue: MessageQueue;
      }
    ).queue = new MessageQueue(budget);

    // Start in-flight so subsequent enqueues are queued (not processed).
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Fill to just-under budget: two ~500-char messages (1512+1512 = 3024 bytes).
    const accepted1 = conversation.enqueueMessage({
      content: "x".repeat(500),
      requestId: "req-big-1",
    });
    const accepted2 = conversation.enqueueMessage({
      content: "y".repeat(500),
      requestId: "req-big-2",
    });
    expect(accepted1.queued).toBe(true);
    expect(accepted2.queued).toBe(true);
    // A third would push the queue over budget → rejected. Capture its
    // onEvent callback so we can verify the queue_full error event reaches
    // the rejected caller (not just the synchronous return value).
    const rejectedEvents: ServerMessage[] = [];
    const rejected = conversation.enqueueMessage({
      content: "z".repeat(500),
      onEvent: (e) => rejectedEvents.push(e),
      requestId: "req-over",
    });
    expect(rejected.queued).toBe(false);
    expect(rejected.rejected).toBe(true);
    expect(conversation.getQueueDepth()).toBe(2);

    // The rejected caller must have received a `queue_full` error event on
    // its own onEvent callback — event emission is part of the public
    // contract, not just the return value.
    const queueFullErr = rejectedEvents.find(
      (e) => e.type === "error" && e.category === "queue_full",
    );
    expect(queueFullErr).toBeDefined();
    if (queueFullErr && queueFullErr.type === "error") {
      expect(queueFullErr.category).toBe("queue_full");
      expect(typeof queueFullErr.message).toBe("string");
      expect(queueFullErr.message.length).toBeGreaterThan(0);
    }

    // Complete in-flight → drain pulls both queued passthroughs as ONE batched run.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);
    expect(conversation.getQueueDepth()).toBe(0);

    // Resolve the batched run.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    // After the full drain, the byte budget must be fully reclaimed — a fresh
    // round of enqueues up to the budget should succeed again. Spin up another
    // in-flight message to reach the queueing state.
    const p2 = conversation.processMessage({
      content: "msg-2",
      attachments: [],
      requestId: "req-2",
    });
    await waitForPendingRun(3);
    expect(
      conversation.enqueueMessage({
        content: "a".repeat(500),
        requestId: "req-a",
      }).queued,
    ).toBe(true);
    expect(
      conversation.enqueueMessage({
        content: "b".repeat(500),
        requestId: "req-b",
      }).queued,
    ).toBe(true);

    await resolveRun(2);
    await p2;
    await waitForPendingRun(4);
    await resolveRun(3);
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Batched drain — correctness fixes (surface exclusion, abort, last-successful
// tracking, single activity-state emission)
// ---------------------------------------------------------------------------

describe("Batched drain correctness fixes", () => {
  beforeEach(() => {
    pendingRuns = [];
    capturedAddMessages.length = 0;
  });

  test("surface-action messages are not batched with regular passthroughs", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsSurface: ServerMessage[] = [];
    const eventsRegular: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a surface-action message (activeSurfaceId set + tracked in
    // surfaceActionRequestIds) followed by a regular passthrough from the
    // same interface. The batch builder must reject the surface-action head
    // so each drains as its own run.
    conversation.surfaceActionRequestIds.add("req-surface");
    conversation.enqueueMessage({
      content: "surface action response",
      onEvent: (e) => eventsSurface.push(e),
      requestId: "req-surface",
      activeSurfaceId: "surface-1",
    });
    conversation.enqueueMessage({
      content: "regular follow-up",
      onEvent: (e) => eventsRegular.push(e),
      requestId: "req-regular",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete run 0 → drain must NOT batch the surface-action with the
    // regular passthrough. Expect the surface-action to drain as a single
    // run first.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // The second run is the surface-action single-message run.
    const surfaceUserRowsAfterRun2 = capturedAddMessages.filter(
      (m) => m.role === "user" && m.content.includes("surface action response"),
    );
    expect(surfaceUserRowsAfterRun2).toHaveLength(1);
    expect(
      eventsSurface.filter((e) => e.type === "message_dequeued"),
    ).toHaveLength(1);

    // Complete the surface-action run; drain pulls the regular passthrough
    // as its own separate run.
    await resolveRun(1);
    await waitForPendingRun(3);
    expect(pendingRuns.length).toBe(3);
    expect(
      eventsRegular.filter((e) => e.type === "message_dequeued"),
    ).toHaveLength(1);

    // Total runs = 3: msg-1, surface-action, regular — NOT 2 (would mean
    // they were batched).
    await resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("abort mid-batch stops tail persists", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue three sibling passthroughs (msg-2 = head, msg-3 = mid,
    // msg-4 = tail). We trigger abort from msg-3's dequeue callback —
    // by the time that fires, msg-2 has already been persisted (which
    // REPLACED the abortController, since persistUserMessage creates a
    // fresh one). Calling abort() now aborts that fresh controller, and
    // the drainBatch loop's abort check after msg-3's persist will break,
    // so msg-4 never persists.
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });

    // Install a one-shot abort trigger on msg-3's dequeue event. We do
    // this before enqueueing so the wrapped callback is what drainBatch
    // invokes.
    let aborted = false;
    const onMsg3Event = (e: ServerMessage) => {
      events3.push(e);
      if (!aborted && e.type === "message_dequeued") {
        aborted = true;
        conversation.abort();
      }
    };
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: onMsg3Event,
      requestId: "req-3",
    });
    conversation.enqueueMessage({
      content: "msg-4",
      onEvent: (e) => events4.push(e),
      requestId: "req-4",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    const persistedUserRowCountBefore = capturedAddMessages.filter(
      (m) => m.role === "user",
    ).length;

    // Complete run 0 → drain pulls the sibling batch.
    await resolveRun(0);
    await p1;

    // Give the drain loop a chance to iterate. Abort happens on msg-3's
    // dequeue (between msg-2's persist and msg-3's persist), so msg-3 may
    // still persist before the abort check at the end of its iteration.
    // Either way, msg-4 must NOT persist.
    await new Promise((r) => setTimeout(r, 30));

    const userRowsAfter = capturedAddMessages
      .slice(persistedUserRowCountBefore)
      .filter((m) => m.role === "user");
    const contents = userRowsAfter.map((r) => r.content).join("||");
    expect(contents).toContain("msg-2");
    expect(contents).not.toContain("msg-4");
    expect(events4.filter((e) => e.type === "message_dequeued")).toHaveLength(
      0,
    );
  });

  test("failed tail persist uses last-successful requestId", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue three siblings. Configure addMessage to throw for the second
    // tail (msg-mid) but succeed for msg-head and msg-tail. This simulates
    // a middle tail persist failure — currentRequestId should end up as
    // msg-tail's requestId (the LAST successful persist), not msg-mid's.
    addMessageShouldThrowForContent.add("msg-mid-unique-marker");

    conversation.enqueueMessage({
      content: "msg-head",
      onEvent: (e) => events2.push(e),
      requestId: "req-head",
    });
    conversation.enqueueMessage({
      content: "msg-mid-unique-marker",
      onEvent: (e) => events3.push(e),
      requestId: "req-mid",
    });
    conversation.enqueueMessage({
      content: "msg-tail",
      onEvent: (e) => events4.push(e),
      requestId: "req-tail",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Complete run 0 → batched drain.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // mid should have emitted an error event via persist failure.
    const errMid = events3.find((e) => e.type === "error");
    expect(errMid).toBeDefined();

    // The agent loop should have been invoked with the tail's userMessageId
    // (last SUCCESSFUL persist), not the mid's. We check via currentRequestId
    // on the conversation which drainBatch assigns after the loop.
    expect(
      (conversation as unknown as { currentRequestId?: string })
        .currentRequestId,
    ).toBe("req-tail");

    // Cleanup: resolve the batched run.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 20));
  });

  test("failed tail persist is excluded from fanOutOnEvent agent events", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Mid tail will fail to persist. After the batched run resolves,
    // message_complete (broadcast via fanOutOnEvent) must NOT land on the
    // failed mid tail — it already received an error event and persisting
    // the assistant reply for a user message that has no DB row would
    // desync the client.
    addMessageShouldThrowForContent.add("fanout-mid-marker");

    conversation.enqueueMessage({
      content: "fanout-head",
      onEvent: (e) => events2.push(e),
      requestId: "req-fanout-head",
    });
    conversation.enqueueMessage({
      content: "fanout-mid-marker",
      onEvent: (e) => events3.push(e),
      requestId: "req-fanout-mid",
    });
    conversation.enqueueMessage({
      content: "fanout-tail",
      onEvent: (e) => events4.push(e),
      requestId: "req-fanout-tail",
    });

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Drive the batched run to emit message_complete via fanOutOnEvent.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 20));

    expect(events3.find((e) => e.type === "error")).toBeDefined();
    expect(events3.find((e) => e.type === "message_complete")).toBeUndefined();

    expect(events2.find((e) => e.type === "message_complete")).toBeDefined();
    expect(events4.find((e) => e.type === "message_complete")).toBeDefined();
  });

  test("drainBatch emits exactly one activity-state event for the whole batch", async () => {
    const activityStates: ServerMessage[] = [];
    const conversation = makeConversation((msg) => {
      if ("type" in msg && msg.type === "assistant_activity_state") {
        activityStates.push(msg);
      }
    });
    await conversation.loadFromDb();

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Snapshot the count before drain so we only compare batch-emitted
    // transitions (msg-1's processMessage already fired one).
    const baseline = activityStates.length;

    // Enqueue three sibling passthroughs.
    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });
    conversation.enqueueMessage({ content: "msg-3", requestId: "req-3" });
    conversation.enqueueMessage({ content: "msg-4", requestId: "req-4" });

    // Complete run 0 → drain pulls the batched siblings as ONE run.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Filter for "message_dequeued" reasons emitted by the batched drain.
    const batchEmissions = activityStates
      .slice(baseline)
      .filter(
        (m) =>
          "type" in m &&
          m.type === "assistant_activity_state" &&
          (m as { reason?: string }).reason === "message_dequeued",
      );
    expect(batchEmissions).toHaveLength(1);
    expect(batchEmissions[0]).toMatchObject({
      type: "assistant_activity_state",
      reason: "message_dequeued",
      requestId: "req-2", // head's requestId, per the fix
    });

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  // Defensive recovery path: buildPassthroughBatch is designed to make
  // the invariant throw unreachable in practice, so neither the head
  // branch (re-dispatch batch.slice(1) to drainBatch/drainSingleMessage/
  // drainQueue) nor the tail branch (skip + continue) can fire in normal
  // operation. Left as a todo so the harness contract is documented
  // without wedging mainline CI. Covering this would require either
  // (a) reflecting into drainBatch to short-circuit resolveSlash for a
  // specific batch entry, or (b) exposing a seam on SlashContext — both
  // are more invasive than the safety-net value justifies.
  test.todo(
    "invariant violation in persist loop triggers error event + recovery, not stranded state",
    async () => {
      // no-op: see comment above.
    },
  );
});

// ---------------------------------------------------------------------------
// Queue policy primitives
// ---------------------------------------------------------------------------

describe("Conversation queue policy helpers", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("hasQueuedMessages() returns false on a fresh conversation", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();
    expect(conversation.hasQueuedMessages()).toBe(false);
  });

  test("hasQueuedMessages() returns true after enqueuing while processing", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing to make the session busy
    conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a message while processing
    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });
    expect(conversation.hasQueuedMessages()).toBe(true);

    // Cleanup: resolve the pending run
    await resolveRun(0);
    await waitForPendingRun(2);
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("canHandoffAtCheckpoint() returns false when not processing", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Not processing, no queued messages
    expect(conversation.canHandoffAtCheckpoint()).toBe(false);
  });

  test("canHandoffAtCheckpoint() returns false when processing but no queued messages", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing — but don't enqueue anything
    conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    expect(conversation.isProcessing()).toBe(true);
    expect(conversation.hasQueuedMessages()).toBe(false);
    expect(conversation.canHandoffAtCheckpoint()).toBe(false);

    // Cleanup
    await resolveRun(0);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("canHandoffAtCheckpoint() returns true when processing and queue has messages", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing
    conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a message
    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });

    expect(conversation.isProcessing()).toBe(true);
    expect(conversation.hasQueuedMessages()).toBe(true);
    expect(conversation.canHandoffAtCheckpoint()).toBe(true);

    // Cleanup
    await resolveRun(0);
    await waitForPendingRun(2);
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("QueueDrainReason type accepts expected values", () => {
    // Compile-time verification that these are valid QueueDrainReason values
    const reason1: QueueDrainReason = "loop_complete";
    const reason2: QueueDrainReason = "checkpoint_handoff";
    expect(reason1).toBe("loop_complete");
    expect(reason2).toBe("checkpoint_handoff");
  });

  test("QueuePolicy type accepts expected shape", () => {
    // Compile-time verification that the QueuePolicy interface works
    const policy: QueuePolicy = { checkpointHandoffEnabled: true };
    expect(policy.checkpointHandoffEnabled).toBe(true);

    const disabledPolicy: QueuePolicy = { checkpointHandoffEnabled: false };
    expect(disabledPolicy.checkpointHandoffEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint handoff tests
// ---------------------------------------------------------------------------

describe("Conversation checkpoint handoff", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("[experimental] onCheckpoint yields when there is a queued message", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];

    // Start processing first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });
    expect(conversation.hasQueuedMessages()).toBe(true);

    // The pending run should have received an onCheckpoint callback.
    // Simulate the agent loop calling it at a turn boundary.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = await run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });

    // Because there is a queued message, the callback should yield for handoff
    expect(decision).toEqual("handoff");

    // Complete the run so the conversation finishes cleanly
    await resolveRun(0);
    await p1;

    // After yield, the first message should emit generation_handoff
    const handoff = events1.find((e) => e.type === "generation_handoff");
    expect(handoff).toBeDefined();
    expect(handoff).toMatchObject({
      type: "generation_handoff",
      conversationId: "conv-1",
      requestId: "req-1",
      queuedCount: 1,
    });

    // The queued message should now be draining (second run started)
    await waitForPendingRun(2);
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("onCheckpoint returns continue when queue is empty", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing — no enqueued messages
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    expect(conversation.hasQueuedMessages()).toBe(false);

    // The pending run should have an onCheckpoint callback
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = await run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });

    // No queued messages → continue
    expect(decision).toBe("continue");

    // Cleanup
    await resolveRun(0);
    await p1;
  });

  test("[experimental] checkpoint handoff pulls a batched run for all queued siblings", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];

    // Start first message (mid-tool-use — will yield at the next checkpoint)
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue three sibling passthroughs while msg-1 is mid-turn
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
    });
    conversation.enqueueMessage({
      content: "msg-4",
      onEvent: (e) => events4.push(e),
      requestId: "req-4",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Simulate the agent loop yielding at the checkpoint (first run is mid-tool-use)
    const run0 = pendingRuns[0];
    expect(run0.onCheckpoint).toBeDefined();
    const decision = await run0.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });
    expect(decision).toEqual("handoff");

    // Complete first run
    await resolveRun(0);
    await p1;

    // The yielded drain pulls ALL THREE queued siblings as ONE batched run —
    // not three separate runs.
    await waitForPendingRun(2);
    expect(pendingRuns.length).toBe(2);

    // Each client saw its own message_dequeued tagged with its own requestId.
    expect(events2.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(events3.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(events4.some((e) => e.type === "message_dequeued")).toBe(true);

    // Resolve the batched run — message_complete fans out to all three clients.
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    expect(events2.some((e) => e.type === "message_complete")).toBe(true);
    expect(events3.some((e) => e.type === "message_complete")).toBe(true);
    expect(events4.some((e) => e.type === "message_complete")).toBe(true);
  });

  test("[experimental] active run with repeated tool turns + queued message triggers checkpoint handoff", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start processing first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => events2.push(e),
      requestId: "req-2",
    });
    expect(conversation.hasQueuedMessages()).toBe(true);

    // Simulate tool-use turns: the agent loop calls onCheckpoint at each turn boundary.
    // Because there is a queued message, the callback should yield for handoff.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();

    // Simulate multiple tool-use turns before the checkpoint fires
    // Turn 0 — checkpoint yields because msg-2 is waiting
    const decision = await run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });
    expect(decision).toEqual("handoff");

    // Complete the run (AgentLoop resolves after yielding)
    await resolveRun(0);
    await p1;

    // Verify generation_handoff was emitted (not plain message_complete)
    const handoff = events1.find((e) => e.type === "generation_handoff");
    expect(handoff).toBeDefined();
    expect(handoff).toMatchObject({
      type: "generation_handoff",
      conversationId: "conv-1",
      requestId: "req-1",
      queuedCount: 1,
    });
    // message_complete should NOT be in events1 (handoff replaces it)
    const messageComplete = events1.find(
      (e) => e.type === "message_complete" && "conversationId" in e,
    );
    expect(messageComplete).toBeUndefined();

    // The queued message should subsequently drain
    await waitForPendingRun(2);
    expect(events2.some((e) => e.type === "message_dequeued")).toBe(true);

    // Complete the second run
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("queued messages still drain FIFO under multiple handoffs", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const dequeueOrder: string[] = [];

    const eventsA: ServerMessage[] = [];
    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === "message_dequeued") dequeueOrder.push(label);
    };

    // Start processing message A
    const pA = conversation.processMessage({
      content: "msg-A",
      attachments: [],
      onEvent: (e) => eventsA.push(e),
      requestId: "req-A",
    });
    await waitForPendingRun(1);

    // Enqueue messages B, C, D — each on a distinct userMessageInterface so the
    // batch builder stops at each boundary and we see one run per message.
    const meta = (iface: string) => ({
      userMessageInterface: iface,
      assistantMessageInterface: iface,
    });
    conversation.enqueueMessage({
      content: "msg-B",
      onEvent: makeHandler("B"),
      requestId: "req-B",
      metadata: meta("macos"),
    });
    conversation.enqueueMessage({
      content: "msg-C",
      onEvent: makeHandler("C"),
      requestId: "req-C",
      metadata: meta("cli"),
    });
    conversation.enqueueMessage({
      content: "msg-D",
      onEvent: makeHandler("D"),
      requestId: "req-D",
      metadata: meta("vellum"),
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Handoff from A -> B
    const runA = pendingRuns[0];
    expect(runA.onCheckpoint).toBeDefined();
    expect(
      await runA.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toEqual("handoff");
    await resolveRun(0);
    await pA;

    // B should be draining
    await waitForPendingRun(2);

    // Handoff from B -> C
    const runB = pendingRuns[1];
    expect(runB.onCheckpoint).toBeDefined();
    expect(
      await runB.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toEqual("handoff");
    await resolveRun(1);
    await waitForPendingRun(3);

    // Handoff from C -> D
    const runC = pendingRuns[2];
    expect(runC.onCheckpoint).toBeDefined();
    // Only D remains, still should yield
    expect(
      await runC.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toEqual("handoff");
    await resolveRun(2);
    await waitForPendingRun(4);

    // D has no more queued -> checkpoint should return 'continue'
    const runD = pendingRuns[3];
    expect(runD.onCheckpoint).toBeDefined();
    expect(
      await runD.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toBe("continue");

    await resolveRun(3);
    await new Promise((r) => setTimeout(r, 10));

    // Verify FIFO dequeue order
    expect(dequeueOrder).toEqual(["B", "C", "D"]);
  });

  test("[experimental] queued persistence failure does not strand later messages", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsA: ServerMessage[] = [];
    const eventsB: ServerMessage[] = [];
    const eventsC: ServerMessage[] = [];

    // Start processing message A
    const pA = conversation.processMessage({
      content: "msg-A",
      attachments: [],
      onEvent: (e) => eventsA.push(e),
      requestId: "req-A",
    });
    await waitForPendingRun(1);

    // Enqueue B (empty content — will fail to persist) and C (valid)
    conversation.enqueueMessage({
      content: "",
      onEvent: (e) => eventsB.push(e),
      requestId: "req-B",
    });
    conversation.enqueueMessage({
      content: "msg-C",
      onEvent: (e) => eventsC.push(e),
      requestId: "req-C",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete message A — triggers drain. B should fail, C should proceed.
    await resolveRun(0);
    await pA;

    // C should have been dequeued and started a new AgentLoop.run
    await waitForPendingRun(2);

    // B should have received an error event
    const errB = eventsB.find((e) => e.type === "error");
    expect(errB).toBeDefined();
    if (errB && errB.type === "error") {
      expect(errB.message).toContain("required");
    }

    // C should have received a dequeued event
    expect(eventsC.some((e) => e.type === "message_dequeued")).toBe(true);

    // Complete C's run
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    // C should have completed successfully
    expect(eventsC.some((e) => e.type === "message_complete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Usage requestId correlation
// ---------------------------------------------------------------------------

describe("Conversation usage requestId correlation", () => {
  beforeEach(() => {
    pendingRuns = [];
    capturedUsageEvents = [];
  });

  test("usage events recorded during a request carry that request ID", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-42",
    });
    await waitForPendingRun(1);

    // Complete the run — this triggers recordUsage with the request's ID
    await resolveRun(0);
    await p1;

    // The usage event should carry the request ID, not null
    const mainAgentUsage = capturedUsageEvents.find(
      (e) => e.actor === "main_agent",
    );
    expect(mainAgentUsage).toBeDefined();
    expect(mainAgentUsage!.requestId).toBe("req-42");
  });
});

// ---------------------------------------------------------------------------
// Terminal trace events on rejection/failure paths
// ---------------------------------------------------------------------------

describe("Terminal trace events on rejection/failure", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("queued persist failure emits request_error trace", async () => {
    const traceEvents: ServerMessage[] = [];
    const conversation = makeConversation((msg) => {
      if ("type" in msg && msg.type === "trace_event") traceEvents.push(msg);
    });
    await conversation.loadFromDb();

    // Start first message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue empty content (will fail persistUserMessage)
    conversation.enqueueMessage({ content: "", requestId: "req-bad" });
    // Enqueue valid message so drain continues
    conversation.enqueueMessage({ content: "msg-3", requestId: "req-3" });

    // Complete first — triggers drain, empty msg fails persist
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Should have a request_error trace for the failed persist
    const errorTrace = traceEvents.find(
      (e) =>
        "kind" in e &&
        e.kind === "request_error" &&
        "requestId" in e &&
        e.requestId === "req-bad",
    );
    expect(errorTrace).toBeDefined();

    // Cleanup
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Host attachment approval tests
// ---------------------------------------------------------------------------

describe("Conversation host attachment directives", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("host attachment prompts and resolves when user allows", async () => {
    const hostPath = "/tmp/vellum-host-attachment-allow.txt";
    writeFileSync(hostPath, "host attachment content");

    try {
      const clientEvents: ServerMessage[] = [];
      const events: ServerMessage[] = [];
      const conversation = makeConversation((msg) => clientEvents.push(msg));
      await conversation.loadFromDb();

      const p1 = conversation.processMessage({
        content: "msg-1",
        attachments: [],
        onEvent: (e) => events.push(e),
        requestId: "req-1",
      });
      await waitForPendingRun(1);

      const run = pendingRuns[0];
      const assistantMsg: Message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Here is your file.\n<vellum-attachment source="host" path="${hostPath}" />`,
          },
        ],
      };
      await run.onEvent({ type: "llm_call_started" });
      run.onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 100,
      });
      run.onEvent({ type: "message_complete", message: assistantMsg });
      run.resolve([...run.messages, assistantMsg]);

      await waitForCondition(() =>
        clientEvents.some((e) => e.type === "confirmation_request"),
      );
      const confirmation = clientEvents.find(
        (e) => e.type === "confirmation_request",
      );
      expect(confirmation).toBeDefined();
      expect(
        (confirmation as { persistentDecisionsAllowed?: boolean })
          .persistentDecisionsAllowed,
      ).toBe(false);
      conversation.handleConfirmationResponse(
        (confirmation as { requestId: string }).requestId,
        "allow",
      );

      await p1;

      expect(conversation.lastAssistantAttachments).toHaveLength(1);
      expect(conversation.lastAssistantAttachments[0].sourceType).toBe(
        "host_file",
      );
      expect(conversation.lastAttachmentWarnings).toHaveLength(0);

      const completion = events.find((e) => e.type === "message_complete");
      expect(completion).toBeDefined();
    } finally {
      rmSync(hostPath, { force: true });
    }
  });

  test("host attachment denial is non-fatal and emits warning text", async () => {
    const hostPath = "/tmp/vellum-host-attachment-deny.txt";
    writeFileSync(hostPath, "host attachment content");

    try {
      const clientEvents: ServerMessage[] = [];
      const events: ServerMessage[] = [];
      const conversation = makeConversation((msg) => clientEvents.push(msg));
      await conversation.loadFromDb();

      const p1 = conversation.processMessage({
        content: "msg-1",
        attachments: [],
        onEvent: (e) => events.push(e),
        requestId: "req-1",
      });
      await waitForPendingRun(1);

      const run = pendingRuns[0];
      const assistantMsg: Message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Here is your file.\n<vellum-attachment source="host" path="${hostPath}" />`,
          },
        ],
      };
      await run.onEvent({ type: "llm_call_started" });
      run.onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 100,
      });
      run.onEvent({ type: "message_complete", message: assistantMsg });
      run.resolve([...run.messages, assistantMsg]);

      await waitForCondition(() =>
        clientEvents.some((e) => e.type === "confirmation_request"),
      );
      const confirmation = clientEvents.find(
        (e) => e.type === "confirmation_request",
      );
      expect(confirmation).toBeDefined();
      conversation.handleConfirmationResponse(
        (confirmation as { requestId: string }).requestId,
        "deny",
      );

      await p1;

      expect(conversation.lastAssistantAttachments).toHaveLength(0);
      expect(
        conversation.lastAttachmentWarnings.some((w) =>
          w.includes("access denied by user"),
        ),
      ).toBe(true);

      // Attachment warnings are surfaced on the completion payload instead of
      // being emitted as late assistant_text_delta events.
      const warningDelta = events.find(
        (e) =>
          e.type === "assistant_text_delta" &&
          e.text.includes("Attachment warning:"),
      );
      expect(warningDelta).toBeUndefined();
      const completion = events.find((e) => e.type === "message_complete");
      expect(completion).toBeDefined();
      expect(
        (completion as { attachmentWarnings?: string[] }).attachmentWarnings,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("access denied by user"),
        ]),
      );
    } finally {
      rmSync(hostPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Attachment payload emission tests
// ---------------------------------------------------------------------------

describe("Conversation attachment event payloads", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("message_complete includes assistant attachments", async () => {
    const events: ServerMessage[] = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    const run = pendingRuns[0];
    const assistantMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Here is your chart." }],
    };
    run.onEvent({
      type: "tool_result",
      toolUseId: "tool-1",
      content: "ok",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
        } as any,
      ],
    });
    await run.onEvent({ type: "llm_call_started" });
    run.onEvent({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      model: "mock",
      providerDurationMs: 100,
    });
    // Await the message_complete dispatch so the async persistence pipeline
    // (which sets `state.lastAssistantMessageId`) finishes before the mock
    // resolves `agentLoop.run()` and downstream post-processing runs. The
    // real agent loop in `agent/loop.ts` awaits onEvent before returning,
    // so awaiting here keeps the mock faithful to production semantics.
    await run.onEvent({ type: "message_complete", message: assistantMsg });
    run.resolve([...run.messages, assistantMsg]);

    await p1;

    const completion = events.find(
      (e) => e.type === "message_complete" && Array.isArray(e.attachments),
    );
    expect(completion).toBeDefined();
    const attachments = (
      completion as {
        attachments: Array<{ mimeType: string; data: string; id?: string }>;
      }
    ).attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].data).toBe("iVBORw0K");
    expect(attachments[0].id).toBeDefined();
  });

  test("generation_handoff includes assistant attachments", async () => {
    const events1: ServerMessage[] = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Queue a second message so the first run yields via checkpoint handoff.
    conversation.enqueueMessage({ content: "msg-2", requestId: "req-2" });

    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    expect(
      await run.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toEqual("handoff");

    const assistantMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Handing off with attachment." }],
    };
    run.onEvent({
      type: "tool_result",
      toolUseId: "tool-1",
      content: "ok",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
        } as any,
      ],
    });
    await run.onEvent({ type: "llm_call_started" });
    run.onEvent({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      model: "mock",
      providerDurationMs: 100,
    });
    run.onEvent({ type: "message_complete", message: assistantMsg });
    run.resolve([...run.messages, assistantMsg]);

    await p1;

    const handoff = events1.find(
      (e) => e.type === "generation_handoff" && Array.isArray(e.attachments),
    );
    expect(handoff).toBeDefined();
    const attachments = (
      handoff as {
        attachments: Array<{ mimeType: string; data: string; id?: string }>;
      }
    ).attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].data).toBe("iVBORw0K");

    await waitForPendingRun(2);
    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Regression: cancel semantics + conversation/global error channel split
// ---------------------------------------------------------------------------

describe("Regression: cancel semantics and error channel split", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("user cancellation emits generation_cancelled, never conversation_error", async () => {
    const msgEvents: ServerMessage[] = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing a message — collect events from the per-message callback
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => msgEvents.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // User cancels — sets the abort signal
    conversation.abort();

    // Resolve the pending run so the abort-check path fires
    await resolveRun(0);
    await p1;

    // generation_cancelled should be emitted via the per-message callback
    const cancelEvent = msgEvents.find(
      (e) => e.type === "generation_cancelled",
    );
    expect(cancelEvent).toBeDefined();

    // conversation_error must never appear on cancel
    const conversationErr = msgEvents.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationErr).toBeUndefined();
  });

  test("post-processing failure still attempts turn-boundary commit", async () => {
    const events: ServerMessage[] = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();
    linkAttachmentShouldThrow = true;

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);
    const run = pendingRuns[0];
    const assistantMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "attachment-trigger" }],
    };
    run.onEvent({
      type: "tool_result",
      toolUseId: "tool-1",
      content: "ok",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
        } as any,
      ],
    });
    await run.onEvent({ type: "llm_call_started" });
    run.onEvent({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      model: "mock",
      providerDurationMs: 100,
    });
    // Await the message_complete dispatch so the async persistence pipeline
    // finishes before the mock resolves `agentLoop.run()`. See the matching
    // comment in "message_complete includes assistant attachments".
    await run.onEvent({ type: "message_complete", message: assistantMsg });
    run.resolve([...run.messages, assistantMsg]);
    await p1;

    expect(turnCommitCalls).toHaveLength(1);
    expect(turnCommitCalls[0]).toEqual({
      workspaceDir: "/tmp",
      conversationId: "conv-1",
      turnNumber: 1,
    });
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
  });

  test("provider failure during processing emits both conversation_error and generic error", async () => {
    const allEvents: ServerMessage[] = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => allEvents.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Simulate a provider failure
    pendingRuns[0].reject(new Error("Connection refused"));
    await p1;

    // Should get conversation_error (structured)
    const conversationErr = allEvents.find(
      (e) => e.type === "conversation_error",
    );
    expect(conversationErr).toBeDefined();

    // Should also get generic error
    const genericErr = allEvents.find((e) => e.type === "error");
    expect(genericErr).toBeDefined();
  });

  test("cancel after queued messages produces no conversation_error for any queued entry", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsPerMsg: ServerMessage[][] = [[], [], []];

    conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => eventsPerMsg[0].push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: (e) => eventsPerMsg[1].push(e),
      requestId: "req-2",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => eventsPerMsg[2].push(e),
      requestId: "req-3",
    });

    conversation.abort();

    // No queued message should have received conversation_error
    for (const events of eventsPerMsg) {
      const conversationErr = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationErr).toBeUndefined();
    }

    // Settle the aborted in-flight run so its abort watchdog clears the
    // real-time timer it armed. A leaked ~5s timer otherwise fires during a
    // later test and drives this stale turn into commitTurnChanges, inflating
    // the shared turnCommitCalls counter that other tests assert against.
    await resolveRun(0);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("commitTurnChanges never resolving within budget -> turn still completes and drains queue", async () => {
    // Replace setTimeout with a zero-delay version so the 4000ms
    // raceWithTimeout fires instantly instead of waiting real time.
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: TimerHandler,
      _ms?: number,
      ...args: unknown[]
    ) => {
      return origSetTimeout(fn, 0, ...args);
    }) as typeof setTimeout;

    try {
      const conversation = makeConversation();
      await conversation.loadFromDb();

      turnCommitHangForever = true;

      const events1: ServerMessage[] = [];
      const events2: ServerMessage[] = [];

      // Start first message (promise intentionally not awaited — we test queue drain behavior)
      const _p1 = conversation.processMessage({
        content: "msg-1",
        attachments: [],
        onEvent: (e) => events1.push(e),
        requestId: "req-1",
      });
      await waitForPendingRun(1);

      // Enqueue a second message while the first is processing
      conversation.enqueueMessage({
        content: "msg-2",
        onEvent: (e) => events2.push(e),
        requestId: "req-2",
      });

      // Complete the first agent loop run
      await resolveRun(0);

      // The turn should still complete (timeout fires) and drain the queue
      // even though commitTurnChanges never resolves.
      // With the zero-delay setTimeout wrapper the 4000ms budget fires
      // instantly, so we only need a short wait for the second run.
      await waitForPendingRun(2, 10_000);

      // First message should have completed
      const completion1 = events1.find((e) => e.type === "message_complete");
      expect(completion1).toBeDefined();

      // Second message should have been dequeued
      const dequeued = events2.find((e) => e.type === "message_dequeued");
      expect(dequeued).toBeDefined();

      // The turn commit should have been called
      expect(turnCommitCalls).toHaveLength(1);

      // Complete the second run so the test can clean up
      turnCommitHangForever = false;
      await resolveRun(1);
      await new Promise((r) => origSetTimeout(r, 10));
    } finally {
      turnCommitHangForever = false;
      globalThis.setTimeout = origSetTimeout;
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// MessageQueue byte budget
// ---------------------------------------------------------------------------

describe("MessageQueue byte budget", () => {
  function makeItem(
    content: string,
    requestId = "r",
    attachments: { data: string }[] = [],
  ) {
    return {
      content,
      attachments: attachments.map((a) => ({
        id: "a",
        filename: "f",
        mimeType: "text/plain",
        data: a.data,
      })),
      requestId,
      onEvent: () => {},
      sentAt: Date.now(),
    };
  }

  test("accepts messages within budget", () => {
    const q = new MessageQueue(10_000);
    expect(q.push(makeItem("hello", "r1"))).toBe(true);
    expect(q.length).toBe(1);
  });

  test("rejects message that would exceed byte budget", () => {
    // Budget of 2000 bytes — a single message with ~500 chars of content
    // uses ~1512 bytes (500*2 + 512 overhead). A second should be rejected.
    const q = new MessageQueue(2_000);
    expect(q.push(makeItem("x".repeat(500), "r1"))).toBe(true);
    expect(q.push(makeItem("y".repeat(500), "r2"))).toBe(false);
    expect(q.length).toBe(1);
  });

  test("always accepts first message even if it alone exceeds budget", () => {
    const q = new MessageQueue(100); // tiny budget
    expect(q.push(makeItem("x".repeat(1000), "r1"))).toBe(true);
    expect(q.length).toBe(1);
  });

  test("reclaims budget when messages are shifted", () => {
    const q = new MessageQueue(3_000);
    expect(q.push(makeItem("x".repeat(500), "r1"))).toBe(true);
    expect(q.push(makeItem("y".repeat(500), "r2"))).toBe(false);

    q.shift(); // free up space
    expect(q.push(makeItem("y".repeat(500), "r2"))).toBe(true);
    expect(q.length).toBe(1);
  });

  test("reclaims budget when messages are removed by requestId", () => {
    // Each 500-char item ≈ 1512 bytes (500*2 + 512 overhead).
    // Budget of 4000 fits two items (3024) but not three (4536).
    const q = new MessageQueue(4_000);
    expect(q.push(makeItem("a".repeat(500), "r1"))).toBe(true);
    expect(q.push(makeItem("b".repeat(500), "r2"))).toBe(true);
    expect(q.push(makeItem("c".repeat(500), "r3"))).toBe(false);

    q.removeByRequestId("r1"); // frees 1512 bytes → 1512 remaining
    expect(q.push(makeItem("c".repeat(500), "r3"))).toBe(true);
  });

  test("clear resets byte budget to zero", () => {
    const q = new MessageQueue(3_000);
    q.push(makeItem("x".repeat(500), "r1"));
    q.clear();
    expect(q.totalBytes).toBe(0);
    expect(q.push(makeItem("y".repeat(500), "r2"))).toBe(true);
  });

  test("accounts for attachment data in byte estimate", () => {
    // 1000 chars content = 2512 bytes. Add a 2000 char attachment = +4000 bytes.
    // Total ~6512 bytes. Budget of 5000 should reject.
    const q = new MessageQueue(5_000);
    expect(
      q.push(makeItem("x".repeat(1000), "r1", [{ data: "a".repeat(2000) }])),
    ).toBe(true); // first message always accepted
    // Second message of same size should be rejected
    expect(
      q.push(makeItem("y".repeat(100), "r2", [{ data: "b".repeat(100) }])),
    ).toBe(false);
  });
});

describe("subagent notification user_message_echo suppression", () => {
  beforeEach(() => {
    pendingRuns = [];
    capturedAddMessages.length = 0;
  });

  test("drained subagent-notification message persists and wakes the agent but emits no user_message_echo", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsNotif: ServerMessage[] = [];

    // Occupy the conversation so the injected notification queues.
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);
    expect(conversation.isProcessing()).toBe(true);

    // A daemon-injected subagent completion notification carries
    // `subagentNotification` metadata.
    conversation.enqueueMessage({
      content: '[Subagent "research" completed]',
      onEvent: (e) => eventsNotif.push(e),
      requestId: "req-notif",
      metadata: {
        subagentNotification: {
          subagentId: "sub-1",
          label: "research",
          status: "completed",
        },
      },
    });

    // Resolving the first run drains the queued notification.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // It is still persisted (so the orchestrator LLM sees it in the transcript)
    // and still wakes the agent (a run was created for the drained message)...
    expect(
      capturedAddMessages.some((m) => m.content.includes("Subagent")),
    ).toBe(true);
    expect(pendingRuns.length).toBe(2);
    // ...but no user_message_echo is broadcast, so the client never renders it
    // as a live user bubble.
    expect(eventsNotif.some((e) => e.type === "user_message_echo")).toBe(false);

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("drained ordinary message still emits user_message_echo", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsNormal: ServerMessage[] = [];

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    conversation.enqueueMessage({
      content: "ordinary message",
      onEvent: (e) => eventsNormal.push(e),
      requestId: "req-normal",
    });

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(eventsNormal.some((e) => e.type === "user_message_echo")).toBe(true);

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("drained hidden message persists with hidden metadata and emits no user_message_echo", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsHidden: ServerMessage[] = [];

    // Occupy the conversation so the hidden send queues — e.g. the user
    // closes the channel-setup wizard while the assistant is mid-turn.
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // A hidden `POST /messages` send carries `hidden: true` metadata through
    // the queue branch (see conversation-routes.ts).
    conversation.enqueueMessage({
      content:
        "[User action on channel_setup panel: closed the slack setup wizard]",
      onEvent: (e) => eventsHidden.push(e),
      requestId: "req-hidden",
      metadata: { hidden: true },
    });

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Persisted with the hidden flag so the transcript filter keeps it out
    // of the rendered history...
    const persisted = capturedAddMessages.find((m) =>
      m.content.includes("channel_setup"),
    );
    expect(persisted?.metadata?.hidden).toBe(true);
    // ...the agent still wakes on it...
    expect(pendingRuns.length).toBe(2);
    // ...and no user_message_echo is broadcast, so no visible user bubble.
    expect(eventsHidden.some((e) => e.type === "user_message_echo")).toBe(
      false,
    );

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("drained acp-notification message persists and wakes the agent but emits no user_message_echo", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsNotif: ServerMessage[] = [];

    // Occupy the conversation so the injected notification queues.
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // A daemon-injected ACP completion notification carries `acpNotification`.
    conversation.enqueueMessage({
      content: '[ACP agent "claude" completed]',
      onEvent: (e) => eventsNotif.push(e),
      requestId: "req-acp-notif",
      metadata: {
        acpNotification: { acpSessionId: "acp-1", agent: "claude" },
      },
    });

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Still persisted (so the orchestrator LLM sees it) and still wakes the
    // agent...
    expect(
      capturedAddMessages.some((m) => m.content.includes("ACP agent")),
    ).toBe(true);
    expect(pendingRuns.length).toBe(2);
    // ...but no user_message_echo, so the client never renders a live bubble.
    expect(eventsNotif.some((e) => e.type === "user_message_echo")).toBe(false);

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("drained background-tool wake message persists and wakes the agent but emits no user_message_echo", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsNotif: ServerMessage[] = [];

    // Occupy the conversation so the injected wake queues.
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // The backgrounded bash/host_bash completion wake persists a
    // `<background_event source="background-tool">` row, tagged with the
    // `backgroundEventSource` metadata `persistWakeTriggerMessage` writes.
    conversation.enqueueMessage({
      content:
        '<background_event source="background-tool">Background command completed (id=bg-1, exit=0):</background_event>',
      onEvent: (e) => eventsNotif.push(e),
      requestId: "req-bg-notif",
      metadata: { backgroundEventSource: "background-tool" },
    });

    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Still persisted (so the orchestrator LLM sees it) and still wakes the
    // agent...
    expect(
      capturedAddMessages.some((m) => m.content.includes("background_event")),
    ).toBe(true);
    expect(pendingRuns.length).toBe(2);
    // ...but no user_message_echo, so the client never renders a live bubble.
    expect(eventsNotif.some((e) => e.type === "user_message_echo")).toBe(false);

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });
});
