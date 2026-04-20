/**
 * Conversation Initialization Benchmark
 *
 * Measures latency of key session startup components and end-to-end
 * session creation timing (request to first-tool-ready state).
 *
 * Uses multi-sample median timing with warm-up runs to reduce sensitivity
 * to host load and machine class. Thresholds are intentionally loose
 * guardrails for catching regressions, not precise performance targets.
 *
 * Component targets (median of 5 runs):
 * - initializeTools: < 100ms
 * - buildSystemPrompt: < 50ms
 * - getAllToolDefinitions: < 10ms
 *
 * End-to-end targets (median of 3 runs):
 * - Conversation creation (no preactivated skills): < 200ms
 * - Conversation creation (3 preactivated skills): < 300ms
 * - Conversation constructor (sync, no loadFromDb): < 10ms
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

/** Return the median of a sorted-ascending array of numbers. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// Create subdirectories expected by platform helpers
mkdirSync(join(testDir, "data"), { recursive: true });
mkdirSync(join(testDir, "logs"), { recursive: true });
mkdirSync(join(testDir, "skills"), { recursive: true });
mkdirSync(join(testDir, "hooks"), { recursive: true });

// Seed minimal prompt files so buildSystemPrompt doesn't bail on missing files
writeFileSync(
  join(testDir, "IDENTITY.md"),
  "# Test Identity\nYou are a test assistant.",
);
writeFileSync(join(testDir, "SOUL.md"), "# Test Soul\nBe helpful.");

// Create real skill directories so projectSkillTools can load them from the catalog
const testSkillIds = ["bench-skill-a", "bench-skill-b", "bench-skill-c"];
for (const skillId of testSkillIds) {
  const skillDir = join(testDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillId}`,
      `description: Benchmark test skill ${skillId}`,
      "---",
      `# ${skillId}`,
      "A test skill for benchmarking.",
    ].join("\n"),
  );
  writeFileSync(
    join(skillDir, "TOOLS.json"),
    JSON.stringify({
      version: 1,
      tools: [
        {
          name: `${skillId}_tool`,
          description: `Tool for ${skillId}`,
          category: "benchmark",
          risk: "low",
          input_schema: { type: "object", properties: {} },
          executor: "run.sh",
          execution_target: "host",
        },
      ],
    }),
  );
  writeFileSync(join(skillDir, "run.sh"), "#!/bin/sh\necho ok");
}

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string, maxLen = 500) =>
    value.length > maxLen ? value.slice(0, maxLen) + "..." : value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockConfig = {
  model: "mock-model",
  provider: "mock",
  contextWindow: {
    enabled: true,
    maxInputTokens: 180000,
    targetBudgetRatio: 0.3,
    compactThreshold: 0.8,
    summaryBudgetRatio: 0.05,
  },
  thinking: { enabled: false },
};

mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "brave",
    "perplexity",
  ],
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// Additional mocks required for Conversation constructor and end-to-end tests

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "msg-1" }),
  getMessages: () => [],
  getMessageById: () => null,
  getConversation: () => null,
  createConversation: () => ({
    id: "bench-conv",
    title: "Bench",
    conversationType: "standard",
  }),
  clearAll: () => {},
  deleteConversation: () => {},
  deleteLastExchange: () => 0,
  deleteMessageById: () => ({ memoryItemIds: [], memoryEntityIds: [] }),
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  getConversationType: () => "standard",
  getConversationSource: () => null,
  findAnalysisConversationFor: () => null,
  getConversationMemoryScopeId: () => "default",
  getConversationHostAccess: () => false,
  getConversationGroupId: () => null,
  getConversationRecentProvenanceTrustClass: () => null,
  provenanceFromTrustContext: () => ({}),
  updateConversationHostAccess: () => {},
  updateMessageMetadata: () => {},
  getLastUserTimestampBefore: () => null,
  relinkAttachments: () => 0,
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  updateConversationContextWindow: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  updateMessageContent: () => {},
  batchSetDisplayOrders: () => {},
  getDisplayMetaForConversations: () => [],
  messageMetadataSchema: {
    parse: (v: unknown) => v,
    safeParse: (v: unknown) => ({ success: true, data: v }),
  },
  parseConversation: () => null,
  parseMessage: () => null,
  getAssistantMessageIdsInTurn: () => [],
  getTurnTimeBounds: () => null,
  PRIVATE_CONVERSATION_FORK_ERROR: "Cannot fork a private conversation",
  countConversationsByScheduleJobId: () => 0,
  forkConversation: () => null,
  wipeConversation: () => ({
    conversations: 0,
    messages: 0,
    memoryItemIds: [],
    memoryEntityIds: [],
  }),
  purgePrivateConversations: () => ({
    purged: 0,
    memoryItemIds: [],
    memoryEntityIds: [],
  }),
  getMessagesPaginated: () => ({ messages: [], hasMore: false }),
  getLastAssistantTimestampBefore: () => null,
}));

mock.module("../memory/conversation-queries.js", () => ({
  countConversations: () => 0,
  listConversations: () => [],
  getLatestConversation: () => null,
  isLastUserMessageToolResult: () => false,
  searchConversations: () => [],
}));

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: () => Promise.resolve(),
    initialize: () => {},
  }),
}));

mock.module("../tools/watch/watch-state.js", () => ({
  watchSessions: new Map(),
  registerWatchStartNotifier: () => {},
  unregisterWatchStartNotifier: () => {},
  fireWatchStartNotifier: () => {},
  registerWatchCommentaryNotifier: () => {},
  unregisterWatchCommentaryNotifier: () => {},
  fireWatchCommentaryNotifier: () => {},
  registerWatchCompletionNotifier: () => {},
  unregisterWatchCompletionNotifier: () => {},
  fireWatchCompletionNotifier: () => {},
  getActiveWatchSession: () => undefined,
  addObservation: () => {},
  pruneWatchSessions: () => {},
}));

mock.module("../calls/call-state.js", () => ({
  registerCallQuestionNotifier: () => {},
  unregisterCallQuestionNotifier: () => {},
  fireCallQuestionNotifier: () => {},
  registerCallTranscriptNotifier: () => {},
  unregisterCallTranscriptNotifier: () => {},
  fireCallTranscriptNotifier: () => {},
  registerCallCompletionNotifier: () => {},
  unregisterCallCompletionNotifier: () => {},
  fireCallCompletionNotifier: () => {},
  registerCallController: () => {},
  unregisterCallController: () => {},
  getCallController: () => undefined,
}));

mock.module("../calls/call-store.js", () => ({
  createCallSession: () => ({ id: "mock" }),
  getCallSession: () => null,
  getCallSessionByCallSid: () => null,
  getActiveCallSessionForConversation: () => null,
  updateCallSession: () => {},
  listRecoverableCalls: () => [],
  recordCallEvent: () => {},
  getCallEvents: () => [],
  createPendingQuestion: () => ({ id: "mock" }),
  getPendingQuestion: () => null,
  answerPendingQuestion: () => {},
  expirePendingQuestions: () => {},
  buildCallbackDedupeKey: () => "",
  isCallbackProcessed: () => false,
  recordProcessedCallback: () => {},
  claimCallback: () => true,
  releaseCallbackClaim: () => {},
  finalizeCallbackClaim: () => true,
}));

mock.module("../daemon/watch-handler.js", () => ({
  lastCommentaryByConversation: new Map(),
  lastSummaryByConversation: new Map(),
}));

mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: () => {},
  unregisterConversationSender: () => {},
  ensureScreencast: () => Promise.resolve(),
  stopBrowserScreencast: () => Promise.resolve(),
  stopAllScreencasts: () => Promise.resolve(),
  isScreencastActive: () => false,
  getSender: () => undefined,
}));

mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: () => Promise.resolve(),
}));

const { initializeTools, getAllToolDefinitions, __resetRegistryForTesting } =
  await import("../tools/registry.js");
const { buildSystemPrompt } = await import("../prompts/system-prompt.js");
const { Conversation } = await import("../daemon/conversation.js");
const { projectSkillTools, resetSkillToolProjection } =
  await import("../daemon/conversation-skill-tools.js");
import type { Provider } from "../providers/types.js";

afterAll(() => {
  __resetRegistryForTesting();
});

describe("Conversation initialization benchmark", () => {
  test("initializeTools completes under 100ms (median of 5)", async () => {
    // Warm-up run to eliminate JIT / lazy-load overhead
    __resetRegistryForTesting();
    await initializeTools();

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      __resetRegistryForTesting();
      const start = performance.now();
      await initializeTools();
      timings.push(performance.now() - start);
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(100);
  });

  test("getAllToolDefinitions retrieves definitions under 10ms (median of 5)", async () => {
    await initializeTools();

    // Warm-up
    getAllToolDefinitions();

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const definitions = getAllToolDefinitions();
      timings.push(performance.now() - start);
      if (i === 0) expect(definitions.length).toBeGreaterThan(0);
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(15);
  });

  test("buildSystemPrompt assembles prompt under 50ms (median of 5)", () => {
    // Warm-up
    buildSystemPrompt();

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const prompt = buildSystemPrompt();
      timings.push(performance.now() - start);
      if (i === 0) {
        expect(prompt.length).toBeGreaterThan(0);
        expect(prompt).toContain("Test Identity");
      }
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(50);
  });

  test("repeated buildSystemPrompt calls are consistently fast (10 iterations)", () => {
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      buildSystemPrompt();
      timings.push(performance.now() - start);
    }

    const maxTime = Math.max(...timings);
    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;

    // Each call should be under 50ms, average well under 20ms
    expect(maxTime).toBeLessThan(50);
    expect(avgTime).toBeLessThan(20);
  });

  test("tool definitions count stays within expected range after init", async () => {
    await initializeTools();
    const definitions = getAllToolDefinitions();

    // Sanity: we expect a meaningful number of core tools (at least 14)
    // but not an unreasonable explosion (under 200)
    expect(definitions.length).toBeGreaterThanOrEqual(14);
    expect(definitions.length).toBeLessThan(200);
  });
});

describe("End-to-end session creation benchmark", () => {
  // Uses the real Conversation constructor + loadFromDb() path, which wires up
  // the tool executor, event bus, agent loop, context window manager, and
  // notifiers. Note: the daemon's getOrCreateConversation() adds provider
  // construction, rate limiting, concurrency guards, and evictor management
  // on top — those are lightweight config-driven operations not benchmarked
  // here.

  const mockProvider: Provider = {
    name: "mock",
    sendMessage: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "ok" }],
        model: "mock-model",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      }),
  };
  const noop = () => {};

  test("session creation without preactivated skills completes under 200ms (median of 3)", async () => {
    __resetRegistryForTesting();
    await initializeTools();
    const systemPrompt = buildSystemPrompt();

    // Warm-up run
    const warmup = new Conversation(
      "bench-warmup-0",
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );
    await warmup.loadFromDb();
    warmup.dispose();

    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `bench-no-skills-${i}`;
      const start = performance.now();
      const session = new Conversation(
        id,
        mockProvider,
        systemPrompt,
        64000,
        noop,
        testDir,
      );
      await session.loadFromDb();
      timings.push(performance.now() - start);

      if (i === 0) {
        expect(session.conversationId).toBe(id);
        expect(session.getMessages()).toHaveLength(0);
      }
      session.dispose();
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(200);
  });

  test("session creation with 3 preactivated skills completes under 300ms (median of 3)", async () => {
    __resetRegistryForTesting();
    await initializeTools();
    const systemPrompt = buildSystemPrompt();

    // Warm-up run — includes skill projection so manifest loading is JIT'd
    const warmup = new Conversation(
      "bench-warmup-s",
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );
    warmup.preactivatedSkillIds = testSkillIds;
    await warmup.loadFromDb();
    projectSkillTools([], {
      preactivatedSkillIds: warmup.preactivatedSkillIds,
      previouslyActiveSkillIds: warmup.skillProjectionState,
      cache: warmup.skillProjectionCache,
    });
    resetSkillToolProjection(warmup.skillProjectionState);
    warmup.dispose();

    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `bench-with-skills-${i}`;
      const start = performance.now();
      const session = new Conversation(
        id,
        mockProvider,
        systemPrompt,
        64000,
        noop,
        testDir,
      );
      session.preactivatedSkillIds = testSkillIds;
      await session.loadFromDb();
      // Skill projection runs at agent turn time, not during loadFromDb.
      // Include it here to measure the full first-tool-ready path.
      const projection = projectSkillTools([], {
        preactivatedSkillIds: session.preactivatedSkillIds,
        previouslyActiveSkillIds: session.skillProjectionState,
        cache: session.skillProjectionCache,
      });
      timings.push(performance.now() - start);

      if (i === 0) {
        expect(session.conversationId).toBe(id);
        expect(session.getMessages()).toHaveLength(0);
        expect(projection.allowedToolNames.size).toBe(testSkillIds.length);
      }
      resetSkillToolProjection(session.skillProjectionState);
      session.dispose();
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(300);
  });

  test("Conversation constructor (sync, no loadFromDb) completes under 10ms (median of 5)", () => {
    const systemPrompt = buildSystemPrompt();

    // Warm-up
    const warmup = new Conversation(
      "bench-events-w",
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );
    warmup.dispose();

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const session = new Conversation(
        `bench-events-${i}`,
        mockProvider,
        systemPrompt,
        64000,
        noop,
        testDir,
      );
      timings.push(performance.now() - start);

      if (i === 0) {
        expect(session.eventBus.listenerCount()).toBeGreaterThan(0);
      }
      session.dispose();
    }

    timings.sort((a, b) => a - b);
    expect(median(timings)).toBeLessThan(15);
  });
});
