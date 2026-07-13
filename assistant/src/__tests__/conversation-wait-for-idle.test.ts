/**
 * Tests for `Conversation.waitForIdle` — the event-driven replacement for the
 * voice bridge's 50 ms processing-lock poll.
 *
 * Contract: resolves `true` as soon as `processing` is false (synchronous
 * fast path included), `false` on timeout, rejects on signal abort, and is
 * notified from the committed `setProcessing(false)` transition — a clear
 * whose persisted write throws (and therefore reverts) must NOT release
 * waiters.
 */
import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
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

// Controllable persisted-write behavior: `setProcessing` reverts its
// in-memory flag when this throws, and waiters must not observe that
// aborted clear as a release.
let failNextProcessingWrite = false;

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {
    if (failNextProcessingWrite) {
      failNextProcessingWrite = false;
      throw new Error("database is locked (SQLITE_BUSY)");
    }
  },
  isConversationProcessing: () => false,
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../persistence/attachments-store.js", () => ({
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

mock.module("../persistence/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

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
    async run(_options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<Message[]> {
      return [];
    }
  },
}));

// ---------------------------------------------------------------------------
// Import Conversation AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

let conversationSeq = 0;

function makeConversation(): Conversation {
  conversationSeq += 1;
  return new Conversation(
    `conv-wait-for-idle-${conversationSeq}`,
    makeProvider(),
    "system prompt",
    (_msg: ServerMessage) => {},
    "/tmp",
    { maxTokens: 4096 },
  );
}

/** Track a promise's settlement without awaiting it. */
function observe<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation.waitForIdle", () => {
  test("resolves true synchronously-fast when the conversation is already idle", async () => {
    const conversation = makeConversation();
    // Long timeout: if the fast path were missing, resolution would require
    // a lock release that never comes and the test would time out.
    await expect(conversation.waitForIdle({ timeoutMs: 60_000 })).resolves.toBe(
      true,
    );
  });

  test("resolves true when setProcessing(false) fires, with no timer advance", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);

    const waiter = observe(conversation.waitForIdle({ timeoutMs: 60_000 }));
    await flushMicrotasks();
    expect(waiter.settled).toBe(false);

    conversation.setProcessing(false);
    await flushMicrotasks();
    // Only microtasks were flushed — resolution came from the release
    // notification, not from any timer.
    expect(waiter.settled).toBe(true);
    expect(waiter.value).toBe(true);
  });

  test("resolves false on timeout while the lock is held", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);

    await expect(conversation.waitForIdle({ timeoutMs: 10 })).resolves.toBe(
      false,
    );

    // A release after the timeout must not throw against the expired waiter.
    conversation.setProcessing(false);
  });

  test("rejects when the signal aborts mid-wait", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);
    const controller = new AbortController();

    const wait = conversation.waitForIdle({
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(wait).rejects.toBeDefined();

    conversation.setProcessing(false);
  });

  test("rejects immediately for an already-aborted signal", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);
    const controller = new AbortController();
    controller.abort();

    await expect(
      conversation.waitForIdle({
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    conversation.setProcessing(false);
  });

  test("two concurrent waiters both resolve on a single release", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);

    const first = observe(conversation.waitForIdle({ timeoutMs: 60_000 }));
    const second = observe(conversation.waitForIdle({ timeoutMs: 60_000 }));
    await flushMicrotasks();
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    conversation.setProcessing(false);
    await flushMicrotasks();
    expect(first.value).toBe(true);
    expect(second.value).toBe(true);
  });

  test("a clear whose persisted write throws does not release waiters", async () => {
    const conversation = makeConversation();
    conversation.setProcessing(true);

    const waiter = observe(conversation.waitForIdle({ timeoutMs: 60_000 }));

    failNextProcessingWrite = true;
    expect(() => conversation.setProcessing(false)).toThrow(
      "database is locked",
    );
    await flushMicrotasks();
    // The write failed, so the flag reverted to processing — the waiter must
    // still be pending.
    expect(conversation.isProcessing()).toBe(true);
    expect(waiter.settled).toBe(false);

    // The retried clear commits and releases the waiter.
    conversation.setProcessing(false);
    await flushMicrotasks();
    expect(waiter.value).toBe(true);
  });
});
