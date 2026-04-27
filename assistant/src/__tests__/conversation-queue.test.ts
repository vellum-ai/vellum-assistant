import { rmSync, writeFileSync } from "node:fs";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
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

const mockedConversationHostAccess = new Map<string, boolean>();

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

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  updateConversationContextWindow: () => {},
  getConversationHostAccess: (conversationId: string) =>
    mockedConversationHostAccess.get(conversationId) ?? false,
  updateConversationHostAccess: (
    conversationId: string,
    hostAccess: boolean,
  ) => {
    mockedConversationHostAccess.set(conversationId, hostAccess);
  },
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
    metadata?: Record<string, unknown>,
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
    capturedAddMessages.push({ id, role, content, metadata });
    return { id };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

let linkAttachmentShouldThrow = false;
let mockAttachmentIdCounter = 0;

mock.module("../memory/attachments-store.js", () => ({
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

mock.module("../memory/llm-usage-store.js", () => ({
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
  onEvent: (event: AgentEvent) => void;
  onCheckpoint?: (
    checkpoint: CheckpointInfo,
  ) => CheckpointDecision | Promise<CheckpointDecision>;
}

let pendingRuns: PendingRun[] = [];

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
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      onCheckpoint?: (
        checkpoint: CheckpointInfo,
      ) => CheckpointDecision | Promise<CheckpointDecision>,
    ): Promise<Message[]> {
      return new Promise<Message[]>((resolve, reject) => {
        pendingRuns.push({ resolve, reject, messages, onEvent, onCheckpoint });
      });
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
    4096,
    sendToClient ?? (() => {}),
    "/tmp",
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
function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  // Emit the events runAgentLoop expects
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: `reply-${index}` }],
  };
  run.onEvent({
    type: "usage",
    inputTokens: 10,
    outputTokens: 5,
    model: "mock",
    providerDurationMs: 100,
  });
  run.onEvent({ type: "message_complete", message: assistantMsg });
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );

    // Wait for the first AgentLoop.run to be registered
    await waitForPendingRun(1);

    // Conversation should now be processing
    expect(conversation.isProcessing()).toBe(true);

    // Enqueue second message — should NOT throw
    const result = conversation.enqueueMessage(
      "msg-2",
      [],
      (e) => events2.push(e),
      "req-2",
    );
    expect(result.queued).toBe(true);
    expect(result.requestId).toBe("req-2");
    expect(conversation.getQueueDepth()).toBe(1);

    // Complete the first message
    resolveRun(0);
    await p1;

    // After the first run resolves, the queue drains and triggers a second run.
    await waitForPendingRun(2);

    // The dequeued event should have been sent to events2
    expect(events2.some((e) => e.type === "message_dequeued")).toBe(true);

    // A second AgentLoop.run should now be pending
    expect(pendingRuns.length).toBe(2);

    // Complete the second run
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("[experimental] queued passthrough siblings drain as a single batched run", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue two more sibling passthrough messages
    conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    conversation.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete run 0 → drain pulls msg-2 and msg-3 into ONE batched run.
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    expect(events2.some((e) => e.type === "message_complete")).toBe(true);
    expect(events3.some((e) => e.type === "message_complete")).toBe(true);
  });

  test("message_queued and message_dequeued events are emitted", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events2: ServerMessage[] = [];

    // Start first message
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue second — simulating what handleUserMessage does
    const result = conversation.enqueueMessage(
      "msg-2",
      [],
      (e) => events2.push(e),
      "req-2",
    );
    expect(result.queued).toBe(true);

    // Complete first
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("abort() clears the queue and sends generation_cancelled for each queued message", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue two more
    conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    conversation.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
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
  });

  test("conversation-scoped errors emit both conversation_error and generic error", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events: ServerMessage[] = [];

    // Start a message — blocks on AgentLoop.run
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events.push(e),
      "req-1",
    );
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    expect(conversation.getQueueDepth()).toBe(0);

    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");
    expect(conversation.getQueueDepth()).toBe(1);

    conversation.enqueueMessage("msg-3", [], () => {}, "req-3");
    expect(conversation.getQueueDepth()).toBe(2);

    conversation.enqueueMessage("msg-4", [], () => {}, "req-4");
    expect(conversation.getQueueDepth()).toBe(3);

    // Complete first → drain pulls all three same-interface passthroughs
    // into a single batched run (depth → 0, runs → 2 total).
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(conversation.getQueueDepth()).toBe(0);
    expect(pendingRuns.length).toBe(2);

    // Complete the batched run; conversation finishes cleanly.
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("[experimental] drain continues after a queued message fails to persist", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on AgentLoop.run
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a message with empty content (will fail persistUserMessage)
    conversation.enqueueMessage("", [], (e) => events2.push(e), "req-2");
    // Enqueue a valid message after the bad one
    conversation.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete first message — triggers drain. The empty message should fail
    // to persist, but the drain should continue to msg-3.
    resolveRun(0);
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
    resolveRun(1);
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue 4 messages with interfaces [macos, macos, cli, macos].
    // Expected drain: [macos batch of 2] → [cli single] → [macos single].
    const meta = (iface: string) => ({
      userMessageInterface: iface,
      assistantMessageInterface: iface,
    });
    conversation.enqueueMessage(
      "msg-2",
      [],
      (e) => events2.push(e),
      "req-2",
      undefined,
      undefined,
      meta("macos"),
    );
    conversation.enqueueMessage(
      "msg-3",
      [],
      (e) => events3.push(e),
      "req-3",
      undefined,
      undefined,
      meta("macos"),
    );
    conversation.enqueueMessage(
      "msg-4",
      [],
      (e) => events4.push(e),
      "req-4",
      undefined,
      undefined,
      meta("cli"),
    );
    conversation.enqueueMessage(
      "msg-5",
      [],
      (e) => events5.push(e),
      "req-5",
      undefined,
      undefined,
      meta("macos"),
    );
    expect(conversation.getQueueDepth()).toBe(4);

    // Resolve msg-1 → batched run pulls macos msg-2 + msg-3.
    resolveRun(0);
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
    resolveRun(1);
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
    resolveRun(2);
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

    resolveRun(3);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("slash-in-middle splits the queue at the slash boundary", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsHello: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];
    const eventsWorld: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue ["hello", "/compact", "world"]. /compact resolves to a non-
    // passthrough slash, so the batch builder stops at "hello" (length 1),
    // then /compact takes the single-message /compact short-circuit path
    // (no new runAgentLoop invocation), then "world" drains as its own run.
    conversation.enqueueMessage(
      "hello",
      [],
      (e) => eventsHello.push(e),
      "req-hello",
    );
    conversation.enqueueMessage(
      "/compact",
      [],
      (e) => eventsSlash.push(e),
      "req-slash",
    );
    conversation.enqueueMessage(
      "world",
      [],
      (e) => eventsWorld.push(e),
      "req-world",
    );
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls "hello" as its own run (batch stops at
    // /compact boundary).
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(pendingRuns.length).toBe(2);
    expect(eventsHello.some((e) => e.type === "message_dequeued")).toBe(true);
    // /compact and "world" are still queued.
    expect(conversation.getQueueDepth()).toBe(2);

    // Resolve "hello" → drain pops /compact via the builder-rejected path,
    // runs its short-circuit (no new runAgentLoop), then drains "world".
    resolveRun(1);
    await waitForPendingRun(3);

    // /compact should have emitted its own message_complete via the short-
    // circuit path (not via a runAgentLoop run).
    expect(eventsSlash.some((e) => e.type === "message_complete")).toBe(true);
    expect(eventsWorld.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(pendingRuns.length).toBe(3);

    resolveRun(2);
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue ["plain-a", "/status", "plain-b"]. /status resolves to a non-
    // passthrough slash (kind: "unknown"), so the batch builder stops at
    // "plain-a" (length-1 batch → drainSingleMessage), then /status takes the
    // unknown-slash short-circuit path (no new runAgentLoop invocation — it
    // emits assistant_text_delta + message_complete inline), then "plain-b"
    // drains as its own run.
    conversation.enqueueMessage(
      "plain-a",
      [],
      (e) => eventsPlainA.push(e),
      "req-plain-a",
    );
    conversation.enqueueMessage(
      "/status",
      [],
      (e) => eventsSlash.push(e),
      "req-slash",
    );
    conversation.enqueueMessage(
      "plain-b",
      [],
      (e) => eventsPlainB.push(e),
      "req-plain-b",
    );
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls "plain-a" as its own run (batch stops at
    // the /status boundary).
    resolveRun(0);
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
    resolveRun(1);
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

    resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("attachments are preserved across a batched drain", async () => {
    capturedAddMessages.length = 0;
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start in-flight message
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
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
    conversation.enqueueMessage("with-A", attachA, () => {}, "req-A");
    conversation.enqueueMessage("with-B", attachB, () => {}, "req-B");
    expect(conversation.getQueueDepth()).toBe(2);

    resolveRun(0);
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

    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("byte-budget accounting is unchanged by shiftN-based batching", async () => {
    // Uses a small budget so we can observe reclamation after drain.
    // Each ~500-char message ≈ 1512 bytes.
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const budget = 4000;
    (conversation as unknown as { queue: MessageQueue }).queue =
      new MessageQueue(budget);

    // Start in-flight so subsequent enqueues are queued (not processed).
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Fill to just-under budget: two ~500-char messages (1512+1512 = 3024 bytes).
    const accepted1 = conversation.enqueueMessage(
      "x".repeat(500),
      [],
      () => {},
      "req-big-1",
    );
    const accepted2 = conversation.enqueueMessage(
      "y".repeat(500),
      [],
      () => {},
      "req-big-2",
    );
    expect(accepted1.queued).toBe(true);
    expect(accepted2.queued).toBe(true);
    // A third would push the queue over budget → rejected. Capture its
    // onEvent callback so we can verify the queue_full error event reaches
    // the rejected caller (not just the synchronous return value).
    const rejectedEvents: ServerMessage[] = [];
    const rejected = conversation.enqueueMessage(
      "z".repeat(500),
      [],
      (e) => rejectedEvents.push(e),
      "req-over",
    );
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
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);
    expect(conversation.getQueueDepth()).toBe(0);

    // Resolve the batched run.
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    // After the full drain, the byte budget must be fully reclaimed — a fresh
    // round of enqueues up to the budget should succeed again. Spin up another
    // in-flight message to reach the queueing state.
    const p2 = conversation.processMessage("msg-2", [], () => {}, "req-2");
    await waitForPendingRun(3);
    expect(
      conversation.enqueueMessage("a".repeat(500), [], () => {}, "req-a")
        .queued,
    ).toBe(true);
    expect(
      conversation.enqueueMessage("b".repeat(500), [], () => {}, "req-b")
        .queued,
    ).toBe(true);

    resolveRun(2);
    await p2;
    await waitForPendingRun(4);
    resolveRun(3);
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue a surface-action message (activeSurfaceId set + tracked in
    // surfaceActionRequestIds) followed by a regular passthrough from the
    // same interface. The batch builder must reject the surface-action head
    // so each drains as its own run.
    conversation.surfaceActionRequestIds.add("req-surface");
    conversation.enqueueMessage(
      "surface action response",
      [],
      (e) => eventsSurface.push(e),
      "req-surface",
      "surface-1", // activeSurfaceId
    );
    conversation.enqueueMessage(
      "regular follow-up",
      [],
      (e) => eventsRegular.push(e),
      "req-regular",
    );
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete run 0 → drain must NOT batch the surface-action with the
    // regular passthrough. Expect the surface-action to drain as a single
    // run first.
    resolveRun(0);
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
    resolveRun(1);
    await waitForPendingRun(3);
    expect(pendingRuns.length).toBe(3);
    expect(
      eventsRegular.filter((e) => e.type === "message_dequeued"),
    ).toHaveLength(1);

    // Total runs = 3: msg-1, surface-action, regular — NOT 2 (would mean
    // they were batched).
    resolveRun(2);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue three sibling passthroughs (msg-2 = head, msg-3 = mid,
    // msg-4 = tail). We trigger abort from msg-3's dequeue callback —
    // by the time that fires, msg-2 has already been persisted (which
    // REPLACED the abortController, since persistUserMessage creates a
    // fresh one). Calling abort() now aborts that fresh controller, and
    // the drainBatch loop's abort check after msg-3's persist will break,
    // so msg-4 never persists.
    conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");

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
    conversation.enqueueMessage("msg-3", [], onMsg3Event, "req-3");
    conversation.enqueueMessage("msg-4", [], (e) => events4.push(e), "req-4");
    expect(conversation.getQueueDepth()).toBe(3);

    const persistedUserRowCountBefore = capturedAddMessages.filter(
      (m) => m.role === "user",
    ).length;

    // Complete run 0 → drain pulls the sibling batch.
    resolveRun(0);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue three siblings. Configure addMessage to throw for the second
    // tail (msg-mid) but succeed for msg-head and msg-tail. This simulates
    // a middle tail persist failure — currentRequestId should end up as
    // msg-tail's requestId (the LAST successful persist), not msg-mid's.
    addMessageShouldThrowForContent.add("msg-mid-unique-marker");

    conversation.enqueueMessage(
      "msg-head",
      [],
      (e) => events2.push(e),
      "req-head",
    );
    conversation.enqueueMessage(
      "msg-mid-unique-marker",
      [],
      (e) => events3.push(e),
      "req-mid",
    );
    conversation.enqueueMessage(
      "msg-tail",
      [],
      (e) => events4.push(e),
      "req-tail",
    );
    expect(conversation.getQueueDepth()).toBe(3);

    // Complete run 0 → batched drain.
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 20));
  });

  test("failed tail persist is excluded from fanOutOnEvent agent events", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];
    const events4: ServerMessage[] = [];

    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Mid tail will fail to persist. After the batched run resolves,
    // message_complete (broadcast via fanOutOnEvent) must NOT land on the
    // failed mid tail — it already received an error event and persisting
    // the assistant reply for a user message that has no DB row would
    // desync the client.
    addMessageShouldThrowForContent.add("fanout-mid-marker");

    conversation.enqueueMessage(
      "fanout-head",
      [],
      (e) => events2.push(e),
      "req-fanout-head",
    );
    conversation.enqueueMessage(
      "fanout-mid-marker",
      [],
      (e) => events3.push(e),
      "req-fanout-mid",
    );
    conversation.enqueueMessage(
      "fanout-tail",
      [],
      (e) => events4.push(e),
      "req-fanout-tail",
    );

    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Drive the batched run to emit message_complete via fanOutOnEvent.
    resolveRun(1);
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Snapshot the count before drain so we only compare batch-emitted
    // transitions (msg-1's processMessage already fired one).
    const baseline = activityStates.length;

    // Enqueue three sibling passthroughs.
    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");
    conversation.enqueueMessage("msg-3", [], () => {}, "req-3");
    conversation.enqueueMessage("msg-4", [], () => {}, "req-4");

    // Complete run 0 → drain pulls the batched siblings as ONE run.
    resolveRun(0);
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

    resolveRun(1);
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
    conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue a message while processing
    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");
    expect(conversation.hasQueuedMessages()).toBe(true);

    // Cleanup: resolve the pending run
    resolveRun(0);
    await waitForPendingRun(2);
    resolveRun(1);
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
    conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    expect(conversation.isProcessing()).toBe(true);
    expect(conversation.hasQueuedMessages()).toBe(false);
    expect(conversation.canHandoffAtCheckpoint()).toBe(false);

    // Cleanup
    resolveRun(0);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("canHandoffAtCheckpoint() returns true when processing and queue has messages", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing
    conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue a message
    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");

    expect(conversation.isProcessing()).toBe(true);
    expect(conversation.hasQueuedMessages()).toBe(true);
    expect(conversation.canHandoffAtCheckpoint()).toBe(true);

    // Cleanup
    resolveRun(0);
    await waitForPendingRun(2);
    resolveRun(1);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");
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

    // Because there is a queued message, the callback should return 'yield'
    expect(decision).toBe("yield");

    // Complete the run so the conversation finishes cleanly
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("onCheckpoint returns continue when queue is empty", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing — no enqueued messages
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
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
    resolveRun(0);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue three sibling passthroughs while msg-1 is mid-turn
    conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    conversation.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    conversation.enqueueMessage("msg-4", [], (e) => events4.push(e), "req-4");
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
    expect(decision).toBe("yield");

    // Complete first run
    resolveRun(0);
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
    resolveRun(1);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    expect(conversation.hasQueuedMessages()).toBe(true);

    // Simulate tool-use turns: the agent loop calls onCheckpoint at each turn boundary.
    // Because there is a queued message, the callback should return 'yield'.
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
    expect(decision).toBe("yield");

    // Complete the run (AgentLoop resolves after yielding)
    resolveRun(0);
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
    resolveRun(1);
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
    const pA = conversation.processMessage(
      "msg-A",
      [],
      (e) => eventsA.push(e),
      "req-A",
    );
    await waitForPendingRun(1);

    // Enqueue messages B, C, D — each on a distinct userMessageInterface so the
    // batch builder stops at each boundary and we see one run per message.
    const meta = (iface: string) => ({
      userMessageInterface: iface,
      assistantMessageInterface: iface,
    });
    conversation.enqueueMessage(
      "msg-B",
      [],
      makeHandler("B"),
      "req-B",
      undefined,
      undefined,
      meta("macos"),
    );
    conversation.enqueueMessage(
      "msg-C",
      [],
      makeHandler("C"),
      "req-C",
      undefined,
      undefined,
      meta("cli"),
    );
    conversation.enqueueMessage(
      "msg-D",
      [],
      makeHandler("D"),
      "req-D",
      undefined,
      undefined,
      meta("vellum"),
    );
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
    ).toBe("yield");
    resolveRun(0);
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
    ).toBe("yield");
    resolveRun(1);
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
    ).toBe("yield");
    resolveRun(2);
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

    resolveRun(3);
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
    const pA = conversation.processMessage(
      "msg-A",
      [],
      (e) => eventsA.push(e),
      "req-A",
    );
    await waitForPendingRun(1);

    // Enqueue B (empty content — will fail to persist) and C (valid)
    conversation.enqueueMessage("", [], (e) => eventsB.push(e), "req-B");
    conversation.enqueueMessage("msg-C", [], (e) => eventsC.push(e), "req-C");
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete message A — triggers drain. B should fail, C should proceed.
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));

    // C should have completed successfully
    expect(eventsC.some((e) => e.type === "message_complete")).toBe(true);
  });

  test("onCheckpoint callback is passed to both initial and retry runs", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    // Start processing
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // The first run should have onCheckpoint
    expect(pendingRuns[0].onCheckpoint).toBeDefined();

    // Simulate an ordering error: emit error + resolve with same length
    // to trigger the retry path
    const run0 = pendingRuns[0];
    run0.onEvent({
      type: "error",
      error: new Error(
        "tool_result block not immediately after tool_use block",
      ),
    });
    // Resolve with the same messages (no new messages appended = ordering error)
    run0.resolve([...run0.messages]);

    // Wait for the retry run
    await waitForPendingRun(2);

    // The retry run should also have onCheckpoint
    expect(pendingRuns[1].onCheckpoint).toBeDefined();

    // Complete retry cleanly
    resolveRun(1);
    await p1;
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

    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-42");
    await waitForPendingRun(1);

    // Complete the run — this triggers recordUsage with the request's ID
    resolveRun(0);
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
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue empty content (will fail persistUserMessage)
    conversation.enqueueMessage("", [], () => {}, "req-bad");
    // Enqueue valid message so drain continues
    conversation.enqueueMessage("msg-3", [], () => {}, "req-3");

    // Complete first — triggers drain, empty msg fails persist
    resolveRun(0);
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
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Host attachment approval tests
// ---------------------------------------------------------------------------

describe("Conversation host attachment directives", () => {
  beforeEach(() => {
    pendingRuns = [];
    mockedConversationHostAccess.clear();
  });

  test("host attachment prompts and resolves when user allows", async () => {
    const hostPath = "/tmp/vellum-host-attachment-allow.txt";
    writeFileSync(hostPath, "host attachment content");

    try {
      const clientEvents: ServerMessage[] = [];
      const events: ServerMessage[] = [];
      const conversation = makeConversation((msg) => clientEvents.push(msg));
      await conversation.loadFromDb();

      const p1 = conversation.processMessage(
        "msg-1",
        [],
        (e) => events.push(e),
        "req-1",
      );
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

      expect(mockedConversationHostAccess.get("conv-1")).toBe(true);
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

      const p1 = conversation.processMessage(
        "msg-1",
        [],
        (e) => events.push(e),
        "req-1",
      );
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

    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events.push(e),
      "req-1",
    );
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

    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Queue a second message so the first run yields via checkpoint handoff.
    conversation.enqueueMessage("msg-2", [], () => {}, "req-2");

    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    expect(
      await run.onCheckpoint!({
        turnIndex: 0,
        toolCount: 1,
        hasToolUse: true,
        history: [],
      }),
    ).toBe("yield");

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
    resolveRun(1);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => msgEvents.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // User cancels — sets the abort signal
    conversation.abort();

    // Resolve the pending run so the abort-check path fires
    resolveRun(0);
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

    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events.push(e),
      "req-1",
    );
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

    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => allEvents.push(e),
      "req-1",
    );
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

    conversation.processMessage(
      "msg-1",
      [],
      (e) => eventsPerMsg[0].push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    conversation.enqueueMessage(
      "msg-2",
      [],
      (e) => eventsPerMsg[1].push(e),
      "req-2",
    );
    conversation.enqueueMessage(
      "msg-3",
      [],
      (e) => eventsPerMsg[2].push(e),
      "req-3",
    );

    conversation.abort();

    // No queued message should have received conversation_error
    for (const events of eventsPerMsg) {
      const conversationErr = events.find(
        (e) => e.type === "conversation_error",
      );
      expect(conversationErr).toBeUndefined();
    }
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
      const _p1 = conversation.processMessage(
        "msg-1",
        [],
        (e) => events1.push(e),
        "req-1",
      );
      await waitForPendingRun(1);

      // Enqueue a second message while the first is processing
      conversation.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");

      // Complete the first agent loop run
      resolveRun(0);

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
      resolveRun(1);
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
