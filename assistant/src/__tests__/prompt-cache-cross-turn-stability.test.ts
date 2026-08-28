/**
 * Cross-turn prompt-cache stability, end to end.
 *
 * Prompt caching only pays off when the bytes a provider marks in turn N are
 * still there, at the same position, in turn N+1. That invariant spans three
 * layers that are otherwise tested in isolation: the render pipeline decides
 * which injected blocks persist into history, the agent loop decides whether to
 * flag the latest user message as volatile, and each provider decides where to
 * put its cache breakpoints. A regression in any one of them is invisible to
 * the others' unit tests.
 *
 * So this file drives two consecutive turns through the REAL render path (a
 * live `Conversation` + `AgentLoop`, with only the provider HTTP boundary
 * mocked), captures what the provider actually received, and then replays those
 * exact histories through the real Anthropic and OpenAI transports to assert on
 * the wire: turn 1's payload recurs byte-identically as a prefix of turn 2's,
 * and every boundary marked in turn 1 is marked again in turn 2 so its written
 * prefix stays readable.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Provider SDK mocks: must be registered before the transports are imported
// ---------------------------------------------------------------------------

let lastAnthropicParams: Record<string, unknown> | null = null;

mock.module("@anthropic-ai/sdk", () => {
  const streamImpl = (params: Record<string, unknown>) => {
    lastAnthropicParams = JSON.parse(JSON.stringify(params));
    return {
      on() {
        return this;
      },
      async finalMessage() {
        return {
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 20 },
          stop_reason: "end_turn",
        };
      },
    };
  };
  return {
    default: class MockAnthropic {
      static APIError = class extends Error {};
      messages = { stream: streamImpl };
      beta = { messages: { stream: streamImpl } };
    },
  };
});

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

let lastOpenAIParams: Record<string, unknown> | null = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: async (params: Record<string, unknown>) => {
        lastOpenAIParams = JSON.parse(JSON.stringify(params));
        const events: FakeStreamEvent[] = [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              model: "gpt-5.6-sol",
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        ];
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const event of events) {
              yield event;
            }
          },
        };
      },
    };
  },
}));

// ---------------------------------------------------------------------------
// Daemon-surface mocks: keep a real turn hermetic and fast. The agent loop is
// deliberately NOT mocked: it is part of what this test exercises.
// ---------------------------------------------------------------------------

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
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  setLastNotifiedInferenceProfile: () => {},
  resolveOverrideProfile: () => undefined,
  updateMessageMetadata: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  updateMessageContent: mock(() => {}),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../persistence/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: "att-1" }),
  linkAttachmentToMessage: () => {},
}));
mock.module("../memory/query-builder.js", () => ({
  buildMemoryQuery: () => "",
}));
mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
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

mock.module("../workspace/top-level-scanner.js", () => ({
  MAX_TOP_LEVEL_ENTRIES: 120,
  scanTopLevelDirectories: (rootPath: string) => ({
    rootPath,
    directories: ["src", "tests", "docs"],
    files: ["README.md", "package.json"],
    truncated: false,
  }),
}));

// Avoid real workspace-git initialization on /tmp: `git add -A` there hits
// permission errors on CI runners' systemd-private dirs.
mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

// Import after mocking
import { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { AnthropicProvider } from "../providers/anthropic/client.js";
import { OpenAIResponsesProvider } from "../providers/openai/responses-provider.js";
import {
  createMockProvider,
  type RecordedProviderCall,
  textResponse,
} from "./helpers/mock-provider.js";

// A GPT-5.6 model id from `PROMPT_CACHE_BREAKPOINT_MODEL_IDS`: explicit
// prompt-cache mode only engages for those.
const EXPLICIT_CACHE_MODEL = "gpt-5.6-sol";

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

type WireItem = {
  type?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
};

/** A Responses input item with every cache marker removed. */
function withoutOpenAIMarkers(item: WireItem): WireItem {
  const clone = JSON.parse(JSON.stringify(item)) as WireItem;
  for (const part of clone.content ?? []) {
    delete part.prompt_cache_breakpoint;
  }
  return clone;
}

/** Indexes of Responses input items carrying a cache marker. */
function openAIMarkedIndexes(params: Record<string, unknown> | null): number[] {
  const input = (params?.input ?? []) as WireItem[];
  const marked: number[] = [];
  input.forEach((item, idx) => {
    if (item.content?.some((p) => p.prompt_cache_breakpoint !== undefined)) {
      marked.push(idx);
    }
  });
  return marked;
}

type AnthropicWireMessage = {
  role: string;
  content: Array<Record<string, unknown>>;
};

/** An Anthropic message with every `cache_control` block marker removed. */
function withoutAnthropicMarkers(
  message: AnthropicWireMessage,
): AnthropicWireMessage {
  const clone = JSON.parse(JSON.stringify(message)) as AnthropicWireMessage;
  for (const block of clone.content ?? []) {
    delete block.cache_control;
  }
  return clone;
}

/** Indexes of Anthropic messages carrying a `cache_control` marker. */
function anthropicMarkedIndexes(
  params: Record<string, unknown> | null,
): number[] {
  const messages = (params?.messages ?? []) as AnthropicWireMessage[];
  const marked: number[] = [];
  messages.forEach((message, idx) => {
    if (message.content?.some((b) => b.cache_control !== undefined)) {
      marked.push(idx);
    }
  });
  return marked;
}

/**
 * TTLs marked on the turn-starting user message, the last user message
 * carrying text, which is the boundary the Anthropic client anchors on.
 */
function anthropicTurnStartTtls(
  params: Record<string, unknown> | null,
): string[] {
  const messages = (params?.messages ?? []) as AnthropicWireMessage[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    if (!message.content?.some((b) => b.type === "text")) {
      continue;
    }
    return (message.content ?? [])
      .map((b) => (b.cache_control as { ttl?: string } | undefined)?.ttl)
      .filter((ttl): ttl is string => ttl !== undefined);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Two real turns through the render pipeline
// ---------------------------------------------------------------------------

let calls: RecordedProviderCall[] = [];

beforeAll(async () => {
  clearConversations();
  resetPluginRegistryAndRegisterDefaults();

  const { provider, calls: recorded } = createMockProvider([
    textResponse("ok"),
    textResponse("ok2"),
  ]);
  const conversation = new Conversation(
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  setConversation(conversation.conversationId, conversation);
  await conversation.loadFromDb();

  await conversation.processMessage({ content: "Hello", attachments: [] });
  await conversation.processMessage({ content: "Follow up", attachments: [] });

  calls = recorded;
});

describe("prompt cache cross-turn stability: render pipeline", () => {
  test("turn 2 resends every turn-1 message byte-identically, at the same index", () => {
    expect(calls).toHaveLength(2);

    const turn1 = calls[0].messages;
    const turn2 = calls[1].messages;
    expect(turn1.length).toBeGreaterThan(0);
    expect(turn2.length).toBeGreaterThan(turn1.length);

    // Exact-bytes prefix check. Anything a provider cached in turn 1 is only
    // readable in turn 2 if the prefix it covers is unchanged, so a single
    // re-rendered injected block anywhere in this range is a full cache miss.
    turn1.forEach((message, idx) => {
      expect(JSON.stringify(turn2[idx])).toBe(JSON.stringify(message));
    });
  });

  test("no spotlight in play means neither turn flags the latest user message as volatile", () => {
    for (const call of calls) {
      const config = call.options?.config as
        | Record<string, unknown>
        | undefined;
      expect(config?.mutableLatestUserMessage).toBeUndefined();
    }
  });
});

describe("prompt cache cross-turn stability: OpenAI Responses wire", () => {
  let turn1Params: Record<string, unknown> | null = null;
  let turn2Params: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const provider = new OpenAIResponsesProvider(
      "sk-test",
      EXPLICIT_CACHE_MODEL,
      { codexSubscription: false },
    );
    await provider.sendMessage(calls[0].messages, {
      config: { promptCacheKey: "conv-1" },
    });
    turn1Params = lastOpenAIParams;
    await provider.sendMessage(calls[1].messages, {
      config: { promptCacheKey: "conv-1" },
    });
    turn2Params = lastOpenAIParams;
  });

  test("turn 1 marks at least one boundary", () => {
    expect(turn1Params?.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(openAIMarkedIndexes(turn1Params).length).toBeGreaterThan(0);
  });

  test("turn 1's input items recur identically as a prefix of turn 2's", () => {
    const input1 = (turn1Params?.input ?? []) as WireItem[];
    const input2 = (turn2Params?.input ?? []) as WireItem[];
    expect(input1.length).toBeGreaterThan(0);
    expect(input2.length).toBeGreaterThan(input1.length);

    input1.forEach((item, idx) => {
      expect(JSON.stringify(withoutOpenAIMarkers(input2[idx]))).toBe(
        JSON.stringify(withoutOpenAIMarkers(item)),
      );
    });
  });

  test("every boundary marked in turn 1 is marked again in turn 2", () => {
    // Reads only consider markers present in the current request, so a
    // boundary written last turn is unreachable unless it is re-marked.
    const marked1 = openAIMarkedIndexes(turn1Params);
    const marked2 = openAIMarkedIndexes(turn2Params);
    for (const idx of marked1) {
      expect(marked2).toContain(idx);
    }
  });
});

describe("prompt cache cross-turn stability: Anthropic wire", () => {
  let turn1Params: Record<string, unknown> | null = null;
  let turn2Params: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    await provider.sendMessage(calls[0].messages, {
      systemPrompt: "system prompt",
    });
    turn1Params = lastAnthropicParams;
    await provider.sendMessage(calls[1].messages, {
      systemPrompt: "system prompt",
    });
    turn2Params = lastAnthropicParams;
  });

  test("turn 1 anchors at least one message", () => {
    expect(anthropicMarkedIndexes(turn1Params).length).toBeGreaterThan(0);
  });

  test("turn 1's messages recur identically as a prefix of turn 2's", () => {
    const messages1 = (turn1Params?.messages ?? []) as AnthropicWireMessage[];
    const messages2 = (turn2Params?.messages ?? []) as AnthropicWireMessage[];
    expect(messages1.length).toBeGreaterThan(0);
    expect(messages2.length).toBeGreaterThan(messages1.length);

    messages1.forEach((message, idx) => {
      expect(JSON.stringify(withoutAnthropicMarkers(messages2[idx]))).toBe(
        JSON.stringify(withoutAnthropicMarkers(message)),
      );
    });
  });

  test("turn 2 re-anchors turn 1's turn-start message", () => {
    // Anthropic matches the cache only at breakpoints present in the current
    // request, so the previous turn's anchor must be re-placed for its written
    // prefix to stay reachable.
    const marked1 = anthropicMarkedIndexes(turn1Params);
    const marked2 = anthropicMarkedIndexes(turn2Params);
    expect(marked2).toContain(marked1[marked1.length - 1]);
  });
});

describe("prompt cache cross-turn stability: volatile first turn", () => {
  // A memory-v3 spotlight on the opening message makes it volatile across
  // turns, but it is still fixed within its own turn. The system prompt, the
  // tools, and the message itself must therefore still be written once, so
  // that turn's tool-loop iterations read the prefix back instead of
  // re-billing it. Leaving the request unmarked spends a full-prompt write on
  // every iteration and yields zero reads.
  test("OpenAI: a volatile opening message still gets a breakpoint", async () => {
    const provider = new OpenAIResponsesProvider(
      "sk-test",
      EXPLICIT_CACHE_MODEL,
      { codexSubscription: false },
    );
    await provider.sendMessage(calls[0].messages, {
      config: { mutableLatestUserMessage: true, promptCacheKey: "conv-1" },
    });

    expect(lastOpenAIParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(openAIMarkedIndexes(lastOpenAIParams).length).toBeGreaterThan(0);
  });

  test("Anthropic: a volatile opening message still gets a breakpoint", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    await provider.sendMessage(calls[0].messages, {
      systemPrompt: "system prompt",
      config: { mutableLatestUserMessage: true },
    });

    expect(anthropicMarkedIndexes(lastAnthropicParams).length).toBeGreaterThan(
      0,
    );
  });

  test("Anthropic: a volatile turn start keeps one TTL across its tool loop", async () => {
    // Marking one boundary at two TTLs bills two writes for a single reusable
    // prefix. A volatile turn start can only ever be read back within its own
    // turn, so it takes the short TTL on the opening request and must keep it
    // once tool results arrive, rather than being upgraded to the long TTL.
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    const opening = calls[0].messages;

    await provider.sendMessage(opening, {
      systemPrompt: "system prompt",
      config: { mutableLatestUserMessage: true, cacheTtl: "1h" },
    });
    const openingTtls = anthropicTurnStartTtls(lastAnthropicParams);

    await provider.sendMessage(
      [
        ...opening,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ] as unknown as Message[],
      {
        systemPrompt: "system prompt",
        config: { mutableLatestUserMessage: true, cacheTtl: "1h" },
      },
    );
    const toolLoopTtls = anthropicTurnStartTtls(lastAnthropicParams);

    expect(openingTtls).toEqual(["5m"]);
    expect(toolLoopTtls).toEqual(openingTtls);
  });

  test("Anthropic: a stable turn start still takes the long TTL", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    await provider.sendMessage(calls[0].messages, {
      systemPrompt: "system prompt",
      config: { cacheTtl: "1h" },
    });

    expect(anthropicTurnStartTtls(lastAnthropicParams)).toEqual(["1h"]);
  });
});

// Known cache-stability gap, documented pending a fix:
//
// Daemon-restart divergence: several per-turn blocks are injected into
// in-memory history but never persisted to message metadata
// (voice_call_control, active_workspace / active_dynamic_page,
// channel_command_context, transport_hints, active_subagents, active_thread,
// active_documents; injection at conversation-runtime-assembly.ts, capture
// switch omits them). After a daemon restart or conversation eviction,
// loadFromDb re-renders history without those blocks, so the first request of
// the next turn diverges from the cached prefix and re-writes it in full.
// Conversations that never use those features are unaffected.
describe("prompt cache stability across daemon restart", () => {
  test.todo(
    "history re-rendered via loadFromDb is byte-identical to the in-memory history the provider cached (non-persisted per-turn blocks survive or are stripped consistently)",
    () => {},
  );
});
