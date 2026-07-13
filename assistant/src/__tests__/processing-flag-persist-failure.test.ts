/**
 * Regression: `Conversation.setProcessing(value)` flips the in-memory flag and
 * then persists it to the `processing_started_at` column. If that DB write
 * throws (e.g. SQLITE_BUSY under contention), the in-memory flag must not be
 * left stranded out of sync with the column — it reverts to its prior value
 * and the error re-throws so callers' existing failure handling still runs.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Persistence mock — `setConversationProcessingStartedAt` throws on demand so
// the test can simulate a locked SQLite write.
// ---------------------------------------------------------------------------

let persistShouldThrow = false;

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
  setConversationProcessingStartedAt: () => {
    if (persistShouldThrow) {
      throw new Error("database is locked (SQLITE_BUSY)");
    }
  },
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

import { Conversation } from "../daemon/conversation.js";

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

describe("Conversation.setProcessing persistence failure", () => {
  let conversation: Conversation;

  beforeEach(() => {
    persistShouldThrow = false;
    conversation = makeConversation();
  });

  test("reverts the in-memory flag and re-throws when the DB write fails", () => {
    expect(conversation.isProcessing()).toBe(false);

    persistShouldThrow = true;
    expect(() => conversation.setProcessing(true)).toThrow(
      "database is locked",
    );

    // The persisted column never landed, so the in-memory flag must not be
    // stranded at `true`.
    expect(conversation.isProcessing()).toBe(false);
  });

  test("restores the prior value when clearing fails mid-turn", () => {
    conversation.setProcessing(true);
    expect(conversation.isProcessing()).toBe(true);

    persistShouldThrow = true;
    expect(() => conversation.setProcessing(false)).toThrow(
      "database is locked",
    );

    // Clear didn't persist, so the flag stays consistent with the column.
    expect(conversation.isProcessing()).toBe(true);
  });

  test("commits the flag when the DB write succeeds", () => {
    conversation.setProcessing(true);
    expect(conversation.isProcessing()).toBe(true);

    conversation.setProcessing(false);
    expect(conversation.isProcessing()).toBe(false);
  });
});
