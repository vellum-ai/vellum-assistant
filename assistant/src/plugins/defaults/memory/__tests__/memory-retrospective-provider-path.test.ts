/**
 * LUM-3013 regression: the retrospective's fail-closed advancement gate must
 * hold through the REAL producer chain, not just against a mocked wake.
 *
 * These tests run the real `memoryRetrospectiveJob` handler → the real
 * `wakeAgentForOpportunity` (runtime/agent-wake.ts, NOT mocked) → a
 * conversation double whose `agentLoop` is a real `AgentLoop` driven by a
 * scripted fake `Provider`. Only the provider and the daemon/persistence
 * boundaries are test doubles, so the chain exercises the actual mechanism
 * behind the bug:
 *
 *   - `AgentLoop.run` SWALLOWS provider rejections: the outer catch
 *     (agent/loop.ts, `onEvent({ type: "error" })` + `stopTurn("error")`)
 *     returns normally with the history unchanged.
 *   - The wake then finds no tail output and takes its silent no-op branch
 *     (agent-wake.ts), returning `{ invoked: true, producedToolCalls: false }`.
 *   - `invoked: true` alone must therefore NOT advance
 *     `memory_retrospective_state`: the handler re-reads the fork's persisted
 *     rows (`collectRetrospectiveRunEvidence` → `loadRetrospectiveRunMessages`
 *     → `getMessages`) and only advances when THIS run persisted a durable
 *     memory-writing `tool_use` (`remember` / `scaffold_managed_skill`) or
 *     replied and stopped on its own (a completed no-findings review).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state. Reset between tests.
// ---------------------------------------------------------------------------

const SOURCE_ID = "src-conv-1";
const FORK_ID = "fork-conv-1";

let stateUpserts: Array<{
  conversationId: string;
  lastProcessedMessageId: string;
  lastRunAt: number;
  rememberedLog?: string[];
}> = [];
let lastRunAtBumps: Array<{ conversationId: string; lastRunAt: number }> = [];

let newMessages: Array<{
  id: string;
  createdAt: number;
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  metadata?: string | null;
}> = [];

/**
 * Persisted message rows, keyed by conversation id. `addMessage` appends here
 * and `getMessages` reads it back. The same store serves the handler's
 * instruction staging, the wake's tail persistence, and the finalizer's
 * durable-evidence read, so the evidence gate sees exactly what the real
 * producer chain persisted.
 */
type PersistedRow = {
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
};
let messageStores: Record<string, PersistedRow[]> = {};
let persistedMessageCounter = 0;

let deletedConversationIds: string[] = [];
let forkCalls: Array<{ conversationId: string; throughMessageId?: string }> =
  [];

// ---------------------------------------------------------------------------
// Retrospective-side mocks (mirroring memory-retrospective-job.test.ts, but
// WITHOUT mocking ../../../../runtime/agent-wake.js: the wake runs real).
// ---------------------------------------------------------------------------

mock.module("../memory-retrospective-state.js", () => ({
  getRetrospectiveState: (_id: string) => null,
  upsertRetrospectiveState: (args: {
    conversationId: string;
    lastProcessedMessageId: string;
    lastRunAt: number;
    rememberedLog?: string[];
  }) => {
    stateUpserts.push(args);
  },
  bumpRetrospectiveLastRunAt: (conversationId: string, lastRunAt: number) => {
    lastRunAtBumps.push({ conversationId, lastRunAt });
  },
  appendToRememberedLog: (existing: string[], newEntries: string[]) => [
    ...existing,
    ...newEntries,
  ],
}));

mock.module("../find-most-recent-retrospective-for.js", () => ({
  findMostRecentRetrospectiveFor: (_id: string) => null,
}));

mock.module("../../../../persistence/conversation-crud.js", () => ({
  // Real rows always carry `finalized` (NOT NULL, default 1); the slice
  // filter drops unfinalized rows, so mock rows default to finalized.
  getMessagesAfter: (_id: string, _afterId: string | null) =>
    newMessages.map((row) => ({ finalized: 1, ...row })),
  getMessages: (id: string) => messageStores[id] ?? [],
  // `defaultResolveTarget` in the REAL wake reads the FORK id's row for the
  // archived check, so both rows carry archivedAt/createdAt. The fork's
  // "user" source makes `loadRetrospectiveRunMessages` treat every persisted
  // row as the run's own (legacy-kind), the simplest faithful setup here.
  getConversation: (id: string) => {
    if (id === FORK_ID) {
      return {
        source: "user",
        forkParentMessageId: null,
        title: "Fork",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    }
    return {
      source: "user",
      forkParentMessageId: null,
      title: "Source conversation",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  },
  isConversationProcessing: (_id: string) => false,
  getConversationProcessingStartedAt: (_id: string) => null,
  forkConversationForRetrospective: async (params: {
    conversationId: string;
    throughMessageId?: string;
  }) => {
    forkCalls.push(params);
    return { id: FORK_ID };
  },
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    _options: unknown,
  ) => {
    const store = (messageStores[conversationId] ??= []);
    store.push({ role, content, createdAt: Date.now(), metadata: null });
    persistedMessageCounter += 1;
    return { id: `msg-${persistedMessageCounter}` };
  },
  deleteConversation: (id: string) => {
    deletedConversationIds.push(id);
  },
  deleteConversationGently: async (id: string) => {
    deletedConversationIds.push(id);
    return { segmentIds: [], deletedSummaryIds: [] };
  },
  resolveOverrideProfile: () => undefined,
  getConversationOverrideProfile: () => undefined,
  provenanceFromTrustContext: () => ({}),
  reserveMessage: async () => ({ id: "msg-reserve" }),
}));

mock.module("../../../../daemon/trust-context.js", () => ({
  INTERNAL_GUARDIAN_TRUST_CONTEXT: {
    sourceChannel: "vellum",
    trustClass: "guardian",
  },
}));

mock.module("../../../../prompts/persona-resolver.js", () => ({
  resolveUserSlug: (_trustContext: unknown) => "alice",
}));

mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => "follow-up-job-id",
  upsertMemoryRetrospectiveJob: () => {},
}));

mock.module("../../../../telemetry/watchdog-events-store.js", () => ({
  recordWatchdogEvent: () => {},
}));

mock.module("../../../../config/memory-v3-gate.js", () => ({
  isMemoryEnabled: (config?: { memory?: { enabled?: boolean } }) =>
    config?.memory?.enabled !== false,
  isV3TierActive: () => false,
  isMemoryV3Live: () => false,
  usesConceptPageMemory: () => false,
}));

mock.module("../../../../daemon/conversation-registry.js", () => ({
  findConversation: (_id: string | undefined) => undefined,
}));

// ---------------------------------------------------------------------------
// Wake-side boundary mocks (mirroring runtime/__tests__/agent-wake.test.ts,
// with relative paths adjusted for this directory).
// ---------------------------------------------------------------------------

mock.module("../../../../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../../../../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

mock.module("../../../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: () => {},
}));

mock.module("../../../../daemon/conversation-store.js", () => ({
  // The real wake's `defaultResolveTarget` lands here after the archived
  // check; it must yield the live fork conversation the run executes on.
  getOrCreateConversation: async (
    _conversationId: string,
    _options?: unknown,
  ) => makeForkConversationDouble(),
}));

mock.module("../../../../config/llm-context-resolution.js", () => ({
  resolveEffectiveContextWindow: () => ({ maxInputTokens: 200_000 }),
}));

mock.module("../../../../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => ({
    enabled: false,
    state: "disabled",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: null,
    thresholdPercent: 95,
    path: null,
    lastCheckedAt: null,
    blockedCapabilities: [],
    error: null,
  }),
}));

mock.module("../../../../daemon/conversation-usage.js", () => ({
  recordUsage: () => {},
}));

mock.module("../../../../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => "log-id",
  backfillMessageIdOnLogs: () => {},
  setAgentLoopExitReasonOnLatestLog: () => {},
  buildProviderErrorResponsePayload: (error: unknown) => ({
    error: String(error),
  }),
}));

import { AgentLoop } from "../../../../agent/loop.js";
import type { Conversation } from "../../../../daemon/conversation.js";
import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../../../providers/types.js";
import { ProviderError } from "../../../../util/errors.js";
import { memoryRetrospectiveJob } from "../memory-retrospective-job.js";

// ---------------------------------------------------------------------------
// Fake provider: the ONLY seam scripted per scenario. Everything between the
// job handler and this `sendMessage` is real production code.
// ---------------------------------------------------------------------------

let providerCalls: Array<{ messages: Message[] }> = [];
let providerImpl: (
  messages: Message[],
  options?: SendMessageOptions,
) => Promise<ProviderResponse> = async () => textOnlyResponse("unused");

const fakeProvider: Provider = {
  name: "fake-provider",
  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    providerCalls.push({ messages: [...messages] });
    return providerImpl(messages, options);
  },
};

function textOnlyResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

function rememberToolUseResponse(): ProviderResponse {
  return {
    content: [
      { type: "text", text: "Saving one fact." },
      {
        type: "tool_use",
        id: "tu-1",
        name: "remember",
        input: { content: "provider-path fact" },
      },
    ],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

// ---------------------------------------------------------------------------
// Conversation double: minimal structural stand-in for the fork the wake
// resolves. Its `agentLoop` is a REAL AgentLoop over the fake provider; its
// message history hydrates from the persisted store (so the instruction row
// the handler staged is the run's baseline, exactly like a DB rehydration).
// ---------------------------------------------------------------------------

function makeForkConversationDouble(): Conversation {
  const messages: Message[] = (messageStores[FORK_ID] ?? []).map((row) => ({
    role: row.role as Message["role"],
    content: JSON.parse(row.content) as Message["content"],
  }));
  const realLoop = new AgentLoop({
    provider: fakeProvider,
    systemPrompt: "test",
    conversationId: FORK_ID,
    // Real executor round-trip: the finalizer's durable-evidence gate
    // requires a matching successful tool_result, so the loop must execute
    // the remember call and persist its result exactly as production does.
    toolExecutor: async (name: string) => {
      if (name === "remember") {
        return { content: "Saved.", isError: false };
      }
      return { content: `unknown tool ${name}`, isError: true };
    },
  });
  const conversation = {
    conversationId: FORK_ID,
    messages,
    getMessages: () => messages,
    isProcessing: () => false,
    setProcessing: (_on: boolean) => {},
    waitForIdle: async (_opts: { timeoutMs: number }) => true,
    drainQueue: async () => {},
    maybeCompact: async () => null,
    subagentAllowedTools: undefined,
    setSubagentAllowedTools: (_tools: Set<string> | undefined) => {},
    preactivatedSkillIds: undefined,
    setPreactivatedSkillIds: (_ids: readonly string[] | undefined) => {},
    trustContext: undefined,
    setTrustContext: (_ctx: unknown) => {},
    currentTurnTrustContext: undefined,
    wakePersonaOverride: undefined,
    contextWindowManager: { estimateInputTokens: () => 0 },
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    buildCurrentSystemPrompt: () => "test-system-prompt",
    provider: { name: "fake-provider" },
    usageStats: {},
    modelOverride: undefined,
    agentLoop: {
      run: (options: Parameters<AgentLoop["run"]>[0]) => realLoop.run(options),
    },
  };
  return conversation as unknown as Conversation;
}

// ---------------------------------------------------------------------------
// Job/config helpers (shape copied from memory-retrospective-job.test.ts).
// ---------------------------------------------------------------------------

function makeConfig(): Parameters<typeof memoryRetrospectiveJob>[1] {
  return {
    memory: {
      v2: { enabled: true },
      retrospective: {
        enabled: true,
        keepSupersededRuns: false,
        matchConversationProfile: false,
        promptPath: null,
        requireUserActivity: false,
        sweepIntervalMs: 8 * 60 * 60 * 1000,
        sweepLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    },
    ui: {
      userTimezone: undefined,
      detectedTimezone: undefined,
    },
  } as unknown as Parameters<typeof memoryRetrospectiveJob>[1];
}

const stubConfig = makeConfig();

function makeJob(conversationId = SOURCE_ID): MemoryJob<{
  conversationId?: string;
}> {
  return {
    id: "job-1",
    type: "memory_retrospective",
    payload: { conversationId },
    status: "pending",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("memoryRetrospectiveJob through the real wake + real agent loop", () => {
  beforeEach(() => {
    stateUpserts = [];
    lastRunAtBumps = [];
    deletedConversationIds = [];
    forkCalls = [];
    messageStores = {};
    persistedMessageCounter = 0;
    providerCalls = [];
    providerImpl = async () => textOnlyResponse("unused");
    newMessages = [
      { id: "m1", createdAt: Date.parse("2026-05-11T10:00:00Z") },
      { id: "m2", createdAt: Date.parse("2026-05-11T10:05:00Z") },
      { id: "m3", createdAt: Date.parse("2026-05-11T10:10:00Z") },
    ];
  });

  test("real provider rejection is classified at the wake layer and leaves the window retryable", async () => {
    // The wake's exit-reason classifier fails a swallowed rejection before
    // finalization (invoked: false, reason run_error), so the handler
    // reports wake_failed. Full rejection-chain coverage (state
    // preservation, prior-fork survival, retry consuming the window) lives
    // in memory-retrospective-wake-chain.test.ts; this case pins only the
    // layered outcome and that the finalizer was never reached.
    providerImpl = async () => {
      throw new ProviderError(
        "This model (test-model) doesn't support image input. Remove the image or switch to a vision-capable model.",
        "openai",
        400,
      );
    };

    const outcome = await memoryRetrospectiveJob(makeJob(), stubConfig);

    expect(outcome.kind).toBe("wake_failed");
    if (outcome.kind === "wake_failed") {
      expect(outcome.reason).toBe("run_error");
    }
    expect(providerCalls.length).toBeGreaterThanOrEqual(1);
    expect(stateUpserts).toHaveLength(0);
    expect(lastRunAtBumps).toHaveLength(1);
    expect(deletedConversationIds).toEqual([FORK_ID]);
  });

  test("durable remember persisted through the real loop advances the cursor", async () => {
    // Scenario B: first call emits a `remember` tool_use; the loop (built
    // without a tool executor) stops after persisting the tool-bearing
    // assistant message, and the wake's tail persistence writes it through
    // `addMessage`. Subsequent calls (defensive) return plain text.
    let call = 0;
    providerImpl = async () => {
      call += 1;
      return call === 1 ? rememberToolUseResponse() : textOnlyResponse("Done.");
    };

    const outcome = await memoryRetrospectiveJob(makeJob(), stubConfig);

    expect(outcome.kind).toBe("invoked");
    expect(providerCalls.length).toBeGreaterThanOrEqual(1);
    expect(stateUpserts).toHaveLength(1);
    expect(stateUpserts[0]!.lastProcessedMessageId).toBe("m3");
    expect(stateUpserts[0]!.rememberedLog).toContain("provider-path fact");
    // The durable evidence really flowed through persistence: the fork store
    // holds the instruction row plus the wake-persisted tool_use tail.
    const persistedRoles = messageStores[FORK_ID]!.map((row) => row.role);
    expect(persistedRoles[0]).toBe("user");
    expect(persistedRoles).toContain("assistant");
    expect(lastRunAtBumps).toHaveLength(0);
  });

  test("a text-only conclusion through the real loop advances as a no-findings pass", async () => {
    // Scenario C: the model answers in its own words and stops without any
    // tool call. The real loop exits on `no_tool_calls`, so the committed
    // reply is a finished empty-handed review and the window is consumed.
    providerImpl = async () => textOnlyResponse("Nothing worth saving.");

    const outcome = await memoryRetrospectiveJob(makeJob(), stubConfig);

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind === "invoked") {
      expect(outcome.noFindings).toBe(true);
    }
    expect(providerCalls.length).toBeGreaterThanOrEqual(1);
    expect(stateUpserts).toHaveLength(1);
    expect(stateUpserts[0]!.rememberedLog).toEqual([]);
  });
});
