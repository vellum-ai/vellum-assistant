import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Session import so Bun applies them at load time.
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
  getDataDir: () => "/tmp",
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

    provider: "mock-provider",
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: "mock-model",
      maxSummaryTokens: 512,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
    permissions: { mode: "workspace" },
    sandbox: { enabled: false },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
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

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
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
  addMessage: (_convId: string, _role: string, _content: string) => {
    return { id: `msg-${Date.now()}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

let linkAttachmentShouldThrow = false;

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {
    if (linkAttachmentShouldThrow) {
      throw new Error("Simulated linkAttachmentToMessage failure");
    }
  },
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",

    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
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

// ---------------------------------------------------------------------------
// Workspace/git turn-commit test hooks.
// ---------------------------------------------------------------------------

const turnCommitCalls: Array<{
  workspaceDir: string;
  sessionId: string;
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
  onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision;
}

let pendingRuns: PendingRun[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
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
// Import Session AFTER mocks are registered.
// ---------------------------------------------------------------------------

import type { QueueDrainReason, QueuePolicy } from "../daemon/session.js";
import { Session } from "../daemon/session.js";
import { MessageQueue } from "../daemon/session-queue-manager.js";

type SessionWithWorkspaceDeps = Session & {
  getWorkspaceGitService?: (_workspaceDir: string) => {
    ensureInitialized: () => Promise<void>;
  };
  commitTurnChanges?: (
    workspaceDir: string,
    sessionId: string,
    turnNumber: number,
    provider?: unknown,
    deadlineMs?: number,
  ) => Promise<void>;
};

function makeSession(sendToClient?: (msg: ServerMessage) => void): Session {
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
    sendToClient ?? (() => {}),
    "/tmp",
  );
  const sessionWithWorkspaceDeps = session as SessionWithWorkspaceDeps;
  sessionWithWorkspaceDeps.getWorkspaceGitService = () => ({
    ensureInitialized: async () => {},
  });
  sessionWithWorkspaceDeps.commitTurnChanges = async (
    workspaceDir: string,
    sessionId: string,
    turnNumber: number,
  ) => {
    turnCommitCalls.push({ workspaceDir, sessionId, turnNumber });
    if (turnCommitHangForever) {
      // Simulate a commit that never resolves within the timeout budget
      await new Promise<void>(() => {});
    }
  };
  return session;
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
 * that `runAgentLoop` expects (usage + message_complete) so the session
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
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session message queue", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("second message is queued when session is busy (does not throw)", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start first message — this will block on AgentLoop.run
    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );

    // Wait for the first AgentLoop.run to be registered
    await waitForPendingRun(1);

    // Session should now be processing
    expect(session.isProcessing()).toBe(true);

    // Enqueue second message — should NOT throw
    const result = session.enqueueMessage(
      "msg-2",
      [],
      (e) => events2.push(e),
      "req-2",
    );
    expect(result.queued).toBe(true);
    expect(result.requestId).toBe("req-2");
    expect(session.getQueueDepth()).toBe(1);

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

  test("[experimental] queued messages are processed in FIFO order", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const processedOrder: string[] = [];

    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === "message_complete") processedOrder.push(label);
    };

    // Start first message
    const p1 = session.processMessage(
      "msg-1",
      [],
      makeHandler("msg-1"),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue two more
    session.enqueueMessage("msg-2", [], makeHandler("msg-2"), "req-2");
    session.enqueueMessage("msg-3", [], makeHandler("msg-3"), "req-3");
    expect(session.getQueueDepth()).toBe(2);

    // Complete first → triggers second
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Complete second → triggers third
    resolveRun(1);
    await waitForPendingRun(3);

    // Complete third
    resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));

    expect(processedOrder).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  test("message_queued and message_dequeued events are emitted", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events2: ServerMessage[] = [];

    // Start first message
    const p1 = session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue second — simulating what handleUserMessage does
    const result = session.enqueueMessage(
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
      sessionId: "conv-1",
      requestId: "req-2",
    });

    // Complete second run so the session finishes cleanly
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("abort() clears the queue and sends generation_cancelled for each queued message", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message
    session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue two more
    session.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    session.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    expect(session.getQueueDepth()).toBe(2);

    // Abort
    session.abort();

    // Queue should be empty
    expect(session.getQueueDepth()).toBe(0);

    // Both queued messages should receive session-scoped cancellation events.
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

    // abort() must NOT emit session_error or generic error for queued discards.
    const err2 = events2.find((e) => e.type === "error");
    expect(err2).toBeUndefined();
    const err3 = events3.find((e) => e.type === "error");
    expect(err3).toBeUndefined();

    const sessionErr2 = events2.find((e) => e.type === "conversation_error");
    expect(sessionErr2).toBeUndefined();

    const sessionErr3 = events3.find((e) => e.type === "conversation_error");
    expect(sessionErr3).toBeUndefined();
  });

  test("session-scoped errors emit both session_error and generic error", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];

    // Start a message — blocks on AgentLoop.run
    const p1 = session.processMessage(
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

    // Should emit session_error (typed, structured)
    const sessionErr = events.find((e) => e.type === "conversation_error");
    expect(sessionErr).toBeDefined();

    // Should also emit generic error (callers rely on error events to detect failures)
    const genericErr = events.find((e) => e.type === "error");
    expect(genericErr).toBeDefined();
  });

  test("queue depth is reported correctly as messages are added and drained", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start first message
    const p1 = session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    expect(session.getQueueDepth()).toBe(0);

    session.enqueueMessage("msg-2", [], () => {}, "req-2");
    expect(session.getQueueDepth()).toBe(1);

    session.enqueueMessage("msg-3", [], () => {}, "req-3");
    expect(session.getQueueDepth()).toBe(2);

    session.enqueueMessage("msg-4", [], () => {}, "req-4");
    expect(session.getQueueDepth()).toBe(3);

    // Complete first → drains one from queue
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(session.getQueueDepth()).toBe(2);

    // Complete second → drains another
    resolveRun(1);
    await waitForPendingRun(3);

    expect(session.getQueueDepth()).toBe(1);

    // Complete third → drains last
    resolveRun(2);
    await waitForPendingRun(4);

    expect(session.getQueueDepth()).toBe(0);

    // Complete fourth (final queued message)
    resolveRun(3);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("[experimental] drain continues after a queued message fails to persist", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on AgentLoop.run
    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a message with empty content (will fail persistUserMessage)
    session.enqueueMessage("", [], (e) => events2.push(e), "req-2");
    // Enqueue a valid message after the bad one
    session.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    expect(session.getQueueDepth()).toBe(2);

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
// Queue policy primitives
// ---------------------------------------------------------------------------

describe("Session queue policy helpers", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("hasQueuedMessages() returns false on a fresh session", async () => {
    const session = makeSession();
    await session.loadFromDb();
    expect(session.hasQueuedMessages()).toBe(false);
  });

  test("hasQueuedMessages() returns true after enqueuing while processing", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing to make the session busy
    session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue a message while processing
    session.enqueueMessage("msg-2", [], () => {}, "req-2");
    expect(session.hasQueuedMessages()).toBe(true);

    // Cleanup: resolve the pending run
    resolveRun(0);
    await waitForPendingRun(2);
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("canHandoffAtCheckpoint() returns false when not processing", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Not processing, no queued messages
    expect(session.canHandoffAtCheckpoint()).toBe(false);
  });

  test("canHandoffAtCheckpoint() returns false when processing but no queued messages", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing — but don't enqueue anything
    session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    expect(session.isProcessing()).toBe(true);
    expect(session.hasQueuedMessages()).toBe(false);
    expect(session.canHandoffAtCheckpoint()).toBe(false);

    // Cleanup
    resolveRun(0);
    await new Promise((r) => setTimeout(r, 10));
  });

  test("canHandoffAtCheckpoint() returns true when processing and queue has messages", async () => {
    const session = makeSession();
    await session.loadFromDb();

    // Start processing
    session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue a message
    session.enqueueMessage("msg-2", [], () => {}, "req-2");

    expect(session.isProcessing()).toBe(true);
    expect(session.hasQueuedMessages()).toBe(true);
    expect(session.canHandoffAtCheckpoint()).toBe(true);

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

describe("Session checkpoint handoff", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("[experimental] onCheckpoint yields when there is a queued message", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];

    // Start processing first message
    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    session.enqueueMessage("msg-2", [], () => {}, "req-2");
    expect(session.hasQueuedMessages()).toBe(true);

    // The pending run should have received an onCheckpoint callback.
    // Simulate the agent loop calling it at a turn boundary.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = run.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });

    // Because there is a queued message, the callback should return 'yield'
    expect(decision).toBe("yield");

    // Complete the run so the session finishes cleanly
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
    const session = makeSession();
    await session.loadFromDb();

    // Start processing — no enqueued messages
    const p1 = session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    expect(session.hasQueuedMessages()).toBe(false);

    // The pending run should have an onCheckpoint callback
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    const decision = run.onCheckpoint!({
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

  test("[experimental] FIFO ordering is preserved through checkpoint handoff", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const processedOrder: string[] = [];

    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === "message_complete" || e.type === "generation_handoff")
        processedOrder.push(label);
    };

    // Start first message
    const p1 = session.processMessage(
      "msg-1",
      [],
      makeHandler("msg-1"),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue two messages
    session.enqueueMessage("msg-2", [], makeHandler("msg-2"), "req-2");
    session.enqueueMessage("msg-3", [], makeHandler("msg-3"), "req-3");
    expect(session.getQueueDepth()).toBe(2);

    // Simulate the agent loop yielding at the checkpoint (first run)
    const run0 = pendingRuns[0];
    expect(run0.onCheckpoint).toBeDefined();
    const decision = run0.onCheckpoint!({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
      history: [],
    });
    expect(decision).toBe("yield");

    // Complete first run
    resolveRun(0);
    await p1;

    // msg-2 should be draining next
    await waitForPendingRun(2);

    // Complete second run (msg-2)
    resolveRun(1);
    await waitForPendingRun(3);

    // Complete third run (msg-3)
    resolveRun(2);
    await new Promise((r) => setTimeout(r, 10));

    // FIFO order: msg-1 completes first, then msg-2, then msg-3
    expect(processedOrder).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  test("[experimental] active run with repeated tool turns + queued message triggers checkpoint handoff", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events1: ServerMessage[] = [];
    const events2: ServerMessage[] = [];

    // Start processing first message
    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a second message while the first is processing
    session.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");
    expect(session.hasQueuedMessages()).toBe(true);

    // Simulate tool-use turns: the agent loop calls onCheckpoint at each turn boundary.
    // Because there is a queued message, the callback should return 'yield'.
    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();

    // Simulate multiple tool-use turns before the checkpoint fires
    // Turn 0 — checkpoint yields because msg-2 is waiting
    const decision = run.onCheckpoint!({
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
    const session = makeSession();
    await session.loadFromDb();

    const dequeueOrder: string[] = [];

    const eventsA: ServerMessage[] = [];
    const makeHandler = (label: string) => (e: ServerMessage) => {
      if (e.type === "message_dequeued") dequeueOrder.push(label);
    };

    // Start processing message A
    const pA = session.processMessage(
      "msg-A",
      [],
      (e) => eventsA.push(e),
      "req-A",
    );
    await waitForPendingRun(1);

    // Enqueue messages B, C, D
    session.enqueueMessage("msg-B", [], makeHandler("B"), "req-B");
    session.enqueueMessage("msg-C", [], makeHandler("C"), "req-C");
    session.enqueueMessage("msg-D", [], makeHandler("D"), "req-D");
    expect(session.getQueueDepth()).toBe(3);

    // Handoff from A -> B
    const runA = pendingRuns[0];
    expect(runA.onCheckpoint).toBeDefined();
    expect(
      runA.onCheckpoint!({
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
      runB.onCheckpoint!({
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
      runC.onCheckpoint!({
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
      runD.onCheckpoint!({
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
    const session = makeSession();
    await session.loadFromDb();

    const eventsA: ServerMessage[] = [];
    const eventsB: ServerMessage[] = [];
    const eventsC: ServerMessage[] = [];

    // Start processing message A
    const pA = session.processMessage(
      "msg-A",
      [],
      (e) => eventsA.push(e),
      "req-A",
    );
    await waitForPendingRun(1);

    // Enqueue B (empty content — will fail to persist) and C (valid)
    session.enqueueMessage("", [], (e) => eventsB.push(e), "req-B");
    session.enqueueMessage("msg-C", [], (e) => eventsC.push(e), "req-C");
    expect(session.getQueueDepth()).toBe(2);

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
    const session = makeSession();
    await session.loadFromDb();

    // Start processing
    const p1 = session.processMessage("msg-1", [], () => {}, "req-1");
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

describe("Session usage requestId correlation", () => {
  beforeEach(() => {
    pendingRuns = [];
    capturedUsageEvents = [];
  });

  test("usage events recorded during a request carry that request ID", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const p1 = session.processMessage("msg-1", [], () => {}, "req-42");
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
    const session = makeSession((msg) => {
      if ("type" in msg && msg.type === "trace_event") traceEvents.push(msg);
    });
    await session.loadFromDb();

    // Start first message
    const p1 = session.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue empty content (will fail persistUserMessage)
    session.enqueueMessage("", [], () => {}, "req-bad");
    // Enqueue valid message so drain continues
    session.enqueueMessage("msg-3", [], () => {}, "req-3");

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

describe("Session host attachment directives", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("host attachment prompts and resolves when user allows", async () => {
    const hostPath = "/tmp/vellum-host-attachment-allow.txt";
    writeFileSync(hostPath, "host attachment content");

    try {
      const clientEvents: ServerMessage[] = [];
      const events: ServerMessage[] = [];
      const session = makeSession((msg) => clientEvents.push(msg));
      await session.loadFromDb();

      const p1 = session.processMessage(
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
      session.handleConfirmationResponse(
        (confirmation as { requestId: string }).requestId,
        "allow",
      );

      await p1;

      expect(session.lastAssistantAttachments).toHaveLength(1);
      expect(session.lastAssistantAttachments[0].sourceType).toBe("host_file");
      expect(session.lastAttachmentWarnings).toHaveLength(0);

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
      const session = makeSession((msg) => clientEvents.push(msg));
      await session.loadFromDb();

      const p1 = session.processMessage(
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
      session.handleConfirmationResponse(
        (confirmation as { requestId: string }).requestId,
        "deny",
      );

      await p1;

      expect(session.lastAssistantAttachments).toHaveLength(0);
      expect(
        session.lastAttachmentWarnings.some((w) =>
          w.includes("access denied by user"),
        ),
      ).toBe(true);

      const warningDelta = events.find(
        (e) =>
          e.type === "assistant_text_delta" &&
          e.text.includes("Attachment warning:"),
      );
      expect(warningDelta).toBeDefined();
      const completion = events.find((e) => e.type === "message_complete");
      expect(completion).toBeDefined();
    } finally {
      rmSync(hostPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Attachment payload emission tests
// ---------------------------------------------------------------------------

describe("Session attachment event payloads", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("message_complete includes assistant attachments", async () => {
    const events: ServerMessage[] = [];
    const session = makeSession();
    await session.loadFromDb();

    const p1 = session.processMessage(
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
    run.onEvent({ type: "message_complete", message: assistantMsg });
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
    const session = makeSession();
    await session.loadFromDb();

    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Queue a second message so the first run yields via checkpoint handoff.
    session.enqueueMessage("msg-2", [], () => {}, "req-2");

    const run = pendingRuns[0];
    expect(run.onCheckpoint).toBeDefined();
    expect(
      run.onCheckpoint!({
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
// Regression: cancel semantics + session/global error channel split
// ---------------------------------------------------------------------------

describe("Regression: cancel semantics and error channel split", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("user cancellation emits generation_cancelled, never session_error", async () => {
    const msgEvents: ServerMessage[] = [];
    const session = makeSession();
    await session.loadFromDb();

    // Start processing a message — collect events from the per-message callback
    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => msgEvents.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // User cancels — sets the abort signal
    session.abort();

    // Resolve the pending run so the abort-check path fires
    resolveRun(0);
    await p1;

    // generation_cancelled should be emitted via the per-message callback
    const cancelEvent = msgEvents.find(
      (e) => e.type === "generation_cancelled",
    );
    expect(cancelEvent).toBeDefined();

    // session_error must never appear on cancel
    const sessionErr = msgEvents.find((e) => e.type === "conversation_error");
    expect(sessionErr).toBeUndefined();
  });

  test("post-processing failure still attempts turn-boundary commit", async () => {
    const events: ServerMessage[] = [];
    const session = makeSession();
    await session.loadFromDb();
    linkAttachmentShouldThrow = true;

    const p1 = session.processMessage(
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
    run.onEvent({ type: "message_complete", message: assistantMsg });
    run.resolve([...run.messages, assistantMsg]);
    await p1;

    expect(turnCommitCalls).toHaveLength(1);
    expect(turnCommitCalls[0]).toEqual({
      workspaceDir: "/tmp",
      sessionId: "conv-1",
      turnNumber: 1,
    });
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
  });

  test("provider failure during processing emits both session_error and generic error", async () => {
    const allEvents: ServerMessage[] = [];
    const session = makeSession();
    await session.loadFromDb();

    const p1 = session.processMessage(
      "msg-1",
      [],
      (e) => allEvents.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Simulate a provider failure
    pendingRuns[0].reject(new Error("Connection refused"));
    await p1;

    // Should get session_error (structured)
    const sessionErr = allEvents.find((e) => e.type === "conversation_error");
    expect(sessionErr).toBeDefined();

    // Should also get generic error
    const genericErr = allEvents.find((e) => e.type === "error");
    expect(genericErr).toBeDefined();
  });

  test("cancel after queued messages produces no session_error for any queued entry", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const eventsPerMsg: ServerMessage[][] = [[], [], []];

    session.processMessage(
      "msg-1",
      [],
      (e) => eventsPerMsg[0].push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    session.enqueueMessage(
      "msg-2",
      [],
      (e) => eventsPerMsg[1].push(e),
      "req-2",
    );
    session.enqueueMessage(
      "msg-3",
      [],
      (e) => eventsPerMsg[2].push(e),
      "req-3",
    );

    session.abort();

    // No queued message should have received session_error
    for (const events of eventsPerMsg) {
      const sessionErr = events.find((e) => e.type === "conversation_error");
      expect(sessionErr).toBeUndefined();
    }
  });

  test("commitTurnChanges never resolving within budget -> turn still completes and drains queue", async () => {
    const session = makeSession();
    await session.loadFromDb();

    turnCommitHangForever = true;

    try {
      const events1: ServerMessage[] = [];
      const events2: ServerMessage[] = [];

      // Start first message (promise intentionally not awaited — we test queue drain behavior)
      const _p1 = session.processMessage(
        "msg-1",
        [],
        (e) => events1.push(e),
        "req-1",
      );
      await waitForPendingRun(1);

      // Enqueue a second message while the first is processing
      session.enqueueMessage("msg-2", [], (e) => events2.push(e), "req-2");

      // Complete the first agent loop run
      resolveRun(0);

      // The turn should still complete (timeout fires) and drain the queue
      // even though commitTurnChanges never resolves.
      // The default turnCommitMaxWaitMs is 4000ms in the config mock,
      // but the mock config doesn't set it, so it defaults to 4000ms.
      // We wait for the second run to be registered, which proves the
      // turn completed and the queue drained despite the hanging commit.
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
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      turnCommitHangForever = false;
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
