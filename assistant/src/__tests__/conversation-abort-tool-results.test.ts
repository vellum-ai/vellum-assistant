import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopRunResult } from "../agent/loop.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
}));

// Track all messages persisted to DB via addMessage (single-shot writes).
let persistedMessages: Array<{ role: string; content: string }> = [];
// Track the latest content written into each reserved row (reserve + update
// pattern). Tool results persist on arrival and finalize at the loop boundary
// through this path, so the final value per row id is what lands in the DB.
let reservedRowContent: Map<string, string> = new Map();
let reserveCounter = 0;

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
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
  addMessage: (_convId: string, role: string, content: string) => {
    persistedMessages.push({ role, content });
    return { id: `msg-${persistedMessages.length}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async () => ({ id: `msg-reserve-${++reserveCounter}` })),
  updateMessageContent: mock((id: string, content: string) => {
    reservedRowContent.set(id, content);
  }),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
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

// Mock AgentLoop that simulates abort after first of multiple tool calls
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
    }): Promise<AgentLoopRunResult> {
      const { messages, onEvent } = options;
      // Prime the assistant row anchor — production code emits this from
      // `AgentLoop.run` just before `provider.sendMessage`.
      await onEvent({ type: "llm_call_started" });
      const history = [...messages];

      // Simulate provider response with 2 tool_use blocks
      const assistantMessage: Message = {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "tu_2", name: "read", input: { path: "/a" } },
        ],
      };
      history.push(assistantMessage);
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
        model: "mock",
        providerDurationMs: 50,
      });
      onEvent({ type: "message_complete", message: assistantMessage });

      // First tool completes — fires tool_result event
      onEvent({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "file list",
        isError: false,
      });

      // Abort happens before second tool. The real AgentLoop synthesizes
      // cancelled results into history AND emits a `cancelled` tool_result
      // event per tool so the orchestrator captures them for persistence and
      // forwards them to the client. tu_1 (already captured via its real
      // tool_result event) wins via the handler's gap-fill guard.
      const resultBlocks: ContentBlock[] = [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "file list",
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          content: "Cancelled by user",
          is_error: true,
        },
      ];
      history.push({ role: "user", content: resultBlocks });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_1",
        content: "Cancelled by user",
        isError: true,
        cancelled: true,
      });
      onEvent({
        type: "tool_result",
        toolUseId: "tu_2",
        content: "Cancelled by user",
        isError: true,
        cancelled: true,
      });

      return {
        history,
        exitReason: null,
        newMessages: history.slice(messages.length),
      };
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

describe("abort tool result persistence", () => {
  test("abort after first of multiple tool calls still persists all required tool_result blocks", async () => {
    persistedMessages = [];
    reservedRowContent = new Map();
    reserveCounter = 0;
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage({
      content: "Run tools",
      attachments: [],
    });

    // Find persisted rows whose final content contains tool_result blocks.
    // Tool results persist on arrival into one grouped row and finalize at the
    // abort/loop boundary; the latest content per reserved row id is what lands
    // in the DB, so one entry per row models the persisted state (a second
    // entry would mean the batch was wrongly split across rows).
    const toolResultUserMessages = Array.from(reservedRowContent.values())
      .map((content) => ({ content }))
      .filter((m) => {
        try {
          const content = JSON.parse(m.content);
          return (
            Array.isArray(content) &&
            content.some(
              (b: Record<string, unknown>) => b.type === "tool_result",
            )
          );
        } catch {
          return false;
        }
      });

    // There should be at least one persisted user message with tool_results
    expect(toolResultUserMessages.length).toBeGreaterThanOrEqual(1);

    // Collect all persisted tool_result tool_use_ids
    const persistedToolUseIds = new Set<string>();
    for (const msg of toolResultUserMessages) {
      const content = JSON.parse(msg.content) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          persistedToolUseIds.add(block.tool_use_id);
        }
      }
    }

    // Both tu_1 and tu_2 must be persisted
    expect(persistedToolUseIds.has("tu_1")).toBe(true);
    expect(persistedToolUseIds.has("tu_2")).toBe(true);

    // No tool_use_id should appear more than once (no duplicates)
    const allToolUseIds: string[] = [];
    for (const msg of toolResultUserMessages) {
      const content = JSON.parse(msg.content) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          allToolUseIds.push(block.tool_use_id);
        }
      }
    }
    const uniqueIds = new Set(allToolUseIds);
    expect(allToolUseIds.length).toBe(uniqueIds.size);
  });

  test("restart/reload after abort does not reproduce provider ordering errors", async () => {
    persistedMessages = [];
    const conversation = makeConversation();
    await conversation.loadFromDb();

    await conversation.processMessage({
      content: "Run tools",
      attachments: [],
    });

    // Simulate reload: the in-memory messages should be valid after repair
    const messages = conversation.getMessages();

    // Every assistant message with tool_use should be immediately followed
    // by a user message with matching tool_result
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) continue;

      const nextMsg = messages[i + 1];
      expect(nextMsg).toBeDefined();
      expect(nextMsg.role).toBe("user");

      for (const tu of toolUseBlocks) {
        if (tu.type !== "tool_use") continue;
        const hasResult = nextMsg.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === tu.id,
        );
        expect(hasResult).toBe(true);
      }
    }
  });
});
