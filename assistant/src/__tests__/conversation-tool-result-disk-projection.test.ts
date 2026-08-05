/**
 * The grouped tool-result row is rewritten in place as each parallel result
 * lands, so it is durable in the DB well before the turn ends. The JSONL disk
 * view is append-only and its records carry no row identity, so every sync of
 * that row adds a line: projecting it anywhere but its final seam multiplies
 * the row on disk (N results yield N + 1 copies, byte-identical because each
 * concurrent writer snapshots the batch after the shared reservation resolves).
 *
 * This fixture drives a turn with three parallel tool results through the real
 * handlers and asserts the row reaches `messages.jsonl` exactly once.
 */

import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopRunResult } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

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

// One entry per `syncMessageToDisk` call, in order. The JSONL file appends one
// record per call, so the call count for a row is the number of lines it
// projects to.
let diskSyncs: string[] = [];

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: (_convId: string, messageId: string) => {
    diskSyncs.push(messageId);
  },
  initConversationDir: () => {},
  updateMetaFile: () => {},
  removeConversationDir: () => {},
  rebuildConversationDiskViewFromDbState: () => {},
  getConversationDirName: () => "conv-1",
  getConversationDirPath: () => "/tmp/conv-1",
}));

// Role each reserved row was opened with, keyed by row id. The grouped
// tool-result row is the `user` reservation; the assistant row is the
// `assistant` one. Content lands through the in-flight writer rather than
// `updateMessageContent`, so the reservation role is what identifies the row.
let reservedRowRoles: Map<string, string> = new Map();
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
    createdAt: 1_700_000_000_000,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: "conv-1" }),
  addMessage: (_convId: string, _role: string, _content: string) => ({
    id: "msg-user",
  }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async (_convId: string, role: string) => {
    const id = `msg-reserve-${++reserveCounter}`;
    reservedRowRoles.set(id, role);
    return { id };
  }),
  updateMessageContent: mock(() => {}),
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

const TOOL_RESULT_COUNT = 3;

// A turn that runs three tools in parallel and completes normally.
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
      await onEvent({ type: "llm_call_started" });
      const history = [...messages];

      const assistantMessage: Message = {
        role: "assistant",
        content: Array.from({ length: TOOL_RESULT_COUNT }, (_, i) => ({
          type: "tool_use" as const,
          id: `toolu_${i + 1}`,
          name: "bash",
          input: { cmd: `echo ${i + 1}` },
        })),
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

      // Parallel results: the real loop emits these synchronously, so every
      // handler reaches the shared row reservation before the first resolves.
      for (let i = 0; i < TOOL_RESULT_COUNT; i++) {
        onEvent({
          type: "tool_result",
          toolUseId: `toolu_${i + 1}`,
          content: `result ${i + 1}`,
          isError: false,
        });
      }

      history.push({
        role: "user",
        content: Array.from({ length: TOOL_RESULT_COUNT }, (_, i) => ({
          type: "tool_result" as const,
          tool_use_id: `toolu_${i + 1}`,
          content: `result ${i + 1}`,
          is_error: false,
        })),
      });

      return {
        history,
        exitReason: null,
        newMessages: history.slice(messages.length),
      };
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

describe("grouped tool-result row disk projection", () => {
  test("a turn with parallel tool results projects the grouped row once", async () => {
    diskSyncs = [];
    reservedRowRoles = new Map();
    reserveCounter = 0;

    const conversation = makeConversation();
    await conversation.loadFromDb();
    await conversation.processMessage({
      content: "Run tools",
      attachments: [],
    });

    // Identify the grouped row by the role it was reserved with rather than
    // by reservation order, so the assertion survives a change in which row
    // is reserved first.
    const groupedRowIds = Array.from(reservedRowRoles.entries())
      .filter(([, role]) => role === "user")
      .map(([id]) => id);

    expect(groupedRowIds).toHaveLength(1);
    const groupedRowId = groupedRowIds[0];

    // The whole batch lands in one row, so one line on disk.
    expect(diskSyncs.filter((id) => id === groupedRowId)).toHaveLength(1);

    // Guard against the assertion passing because the row was never projected
    // at all: the assistant row of the same turn must also reach disk once.
    const assistantRowIds = Array.from(reservedRowRoles.entries())
      .filter(([, role]) => role === "assistant")
      .map(([id]) => id);
    expect(assistantRowIds).toHaveLength(1);
    expect(diskSyncs.filter((id) => id === assistantRowIds[0])).toHaveLength(1);
  });
});
