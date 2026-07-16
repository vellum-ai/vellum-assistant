/**
 * `Conversation.isProcessingStuck()` distinguishes a genuinely-busy
 * conversation (a live turn is running) from a phantom processing flag left
 * behind by a turn that died without clearing it (ATL-1009). The send handler
 * uses this to reject sends into a wedged conversation with a 409 instead of
 * enqueuing them behind a turn that will never drain the queue (ATL-1010).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// The processing-flag DB write is a no-op here — the stuck check reads
// in-memory state only.
mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  setConversationHistoryStrippedAt: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    createdAt: Date.parse("2026-03-19T12:00:00.000Z"),
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: () => ({ id: "msg-1" }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], deletedSummaryIds: [] }),
  deleteLastExchange: () => 0,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../persistence/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: "att-1" }),
  linkAttachmentToMessage: () => {},
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => null,
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

mock.module("../memory/query-builder.js", () => ({
  buildMemoryQuery: () => "",
}));

mock.module("../plugins/defaults/memory/retrieval-budget.js", () => ({
  computeRecallBudget: () => 0,
}));

mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: () => {},
}));

mock.module("../daemon/message-types/sync.js", () => ({
  conversationMetadataSyncTag: (id: string) => `conversation-metadata:${id}`,
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
  recordUsageEvent: () => ({ id: "usage-1", createdAt: Date.now() }),
}));

mock.module("../apps/app-store.js", () => ({
  getApp: () => null,
  updateApp: () => {},
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
    async run(options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<Message[]> {
      return options.messages;
    }
  },
}));

import {
  Conversation,
  STUCK_PROCESSING_THRESHOLD_MS,
} from "../daemon/conversation.js";

function makeConversation(): Conversation {
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
  return new Conversation(
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
}

describe("Conversation.isProcessingStuck", () => {
  let conversation: Conversation;
  const now = Date.parse("2026-03-19T12:00:00.000Z");

  beforeEach(() => {
    conversation = makeConversation();
  });

  test("an idle conversation is never stuck", () => {
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.isProcessingStuck(now)).toBe(false);
  });

  test("a live turn (processing with an active controller) is busy, not stuck", () => {
    conversation.abortController = new AbortController();
    conversation.setProcessing(true);

    // Even long after the turn started, a live un-aborted controller means the
    // turn is really running — queue behind it, don't 409.
    const wayLater = now + STUCK_PROCESSING_THRESHOLD_MS * 100;
    expect(conversation.isProcessingStuck(wayLater)).toBe(false);
  });

  test("a controller-less flag under the age threshold is not yet stuck", () => {
    // Simulate the sub-second window where a canned-greeting / slash reply
    // holds the flag without installing an abort controller.
    conversation.setProcessing(true);
    conversation.abortController = null;

    const justUnder = STUCK_PROCESSING_THRESHOLD_MS - 1;
    expect(conversation.isProcessingStuck(Date.now() + justUnder)).toBe(false);
  });

  test("a controller-less flag past the age threshold is stuck", () => {
    conversation.setProcessing(true);
    conversation.abortController = null;

    const past = Date.now() + STUCK_PROCESSING_THRESHOLD_MS + 1;
    expect(conversation.isProcessingStuck(past)).toBe(true);
  });

  test("a stale flag whose controller was already aborted is stuck", () => {
    const controller = new AbortController();
    conversation.abortController = controller;
    conversation.setProcessing(true);
    controller.abort();

    const past = Date.now() + STUCK_PROCESSING_THRESHOLD_MS + 1;
    expect(conversation.isProcessingStuck(past)).toBe(true);
  });

  test("clearing the flag makes it not stuck again", () => {
    conversation.setProcessing(true);
    conversation.abortController = null;
    const past = Date.now() + STUCK_PROCESSING_THRESHOLD_MS + 1;
    expect(conversation.isProcessingStuck(past)).toBe(true);

    conversation.setProcessing(false);
    expect(conversation.isProcessingStuck(past)).toBe(false);
  });
});
