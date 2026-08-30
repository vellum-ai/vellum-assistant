/**
 * Producer-to-finalizer state-chain coverage for the memory retrospective
 * (LUM-3013).
 *
 * These tests run the REAL chain: `runForkBasedRetrospective` (real fork +
 * real `memory_retrospective_state` rows in the test DB) invokes the REAL
 * `wakeAgentForOpportunity`, which runs a REAL `AgentLoop` whose provider is
 * scripted per test. Provider rejections therefore exercise the loop's actual
 * catch/`stopTurn` path (no manually emitted events), and finalization reads
 * and writes the actual persisted rows.
 *
 * What is stubbed, and why it is outside the contract under proof:
 * - The wake's conversation resolution: the module mock below re-exports the
 *   real `wakeAgentForOpportunity` with an injected `resolveTarget` that
 *   yields a structural conversation double wrapping the real `AgentLoop`
 *   (the default resolver is daemon-hydration machinery, not state logic).
 * - `recordUsage` (cost ledger) and `resolveEffectiveContextWindow` /
 *   disk-pressure status (config lookups): observability and gating leaves.
 *
 * The LUM-3013 data-integrity contract proven here:
 * 1. A provider rejection reaches `invoked: false` BEFORE any state
 *    mutation: no cursor advance, no remembered-log change, no
 *    prior-retrospective deletion; the orphan fork is cleaned up.
 * 2. The failed window stays retryable: a later run over the same window
 *    succeeds and advances state.
 * 3. A usable-output control advances state (cursor, remembered log) and
 *    GCs the superseded prior retrospective, and a pass that reviewed its
 *    window and had nothing to save advances it too, in whatever words the
 *    model chose.
 * 4. A run whose checkpoint went live before a later rejection stays
 *    `invoked: true` (its side effects landed and are honored).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AgentLoop } from "../../../../agent/loop.js";
import type { Conversation } from "../../../../daemon/conversation.js";
import {
  addMessage,
  createConversation,
  forkConversationForRetrospective,
  getConversation,
  getMessages,
} from "../../../../persistence/conversation-crud.js";
import { getDb, getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  conversations,
  memoryJobs,
  memoryRetrospectiveState,
  messages as messagesTable,
} from "../../../../persistence/schema/index.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../../../providers/types.js";
// Capture the real wake before the module mock below re-links the module
// for every importer (including memory-retrospective-job).
import { wakeAgentForOpportunity as importedWake } from "../../../../runtime/agent-wake.js";
import * as realAgentWakeModule from "../../../../runtime/agent-wake.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_GROUP_ID,
} from "../memory-retrospective-constants.js";
import { runForkBasedRetrospective } from "../memory-retrospective-job.js";
import {
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "../memory-retrospective-state.js";

const realWake = importedWake;

// ── Scripted provider ────────────────────────────────────────────────
//
// Each entry is either a canned response or a thrown rejection, consumed in
// order; the last entry repeats. Reassigned per test.
type ProviderStep = { response: ProviderResponse } | { reject: Error };
let providerScript: ProviderStep[] = [];
let providerCallCount = 0;

const scriptedProvider: Provider = {
  name: "mock-provider",
  async sendMessage(
    _messages: Message[],
    _options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const step =
      providerScript[providerCallCount] ??
      providerScript[providerScript.length - 1];
    providerCallCount++;
    if (!step) {
      throw new Error("provider script exhausted");
    }
    if ("reject" in step) {
      throw step.reject;
    }
    return step.response;
  },
};

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

function rememberToolUseResponse(fact: string): ProviderResponse {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "remember",
        input: { content: fact },
      },
    ],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

const rememberToolDef: ToolDefinition[] = [
  {
    name: "remember",
    description: "Save a fact to memory",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
    },
  },
];

// ── Conversation double wrapping a REAL AgentLoop ────────────────────
//
// Structural double for the fork conversation the wake resolves: only the
// members the wake touches, with `agentLoop` a real `AgentLoop` over the
// scripted provider so provider failures exercise the loop's genuine
// catch/stopTurn path. Tail persistence, state reads/writes, and fork
// cleanup all run against the real test DB.
function makeForkConversationDouble(forkId: string): Conversation {
  const rows = getMessages(forkId);
  const messages: Message[] = rows.map((row) => {
    let content: unknown = row.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        // Keep the raw string when not JSON.
      }
    }
    return { role: row.role, content } as Message;
  });

  const agentLoop = new AgentLoop({
    provider: scriptedProvider,
    systemPrompt: "chain-test system prompt",
    conversationId: forkId,
    tools: rememberToolDef,
    toolExecutor: async () => ({ content: "Saved.", isError: false }),
  });

  let processing = false;
  let activeAllowedTools: Set<string> | undefined;
  let persistentTrust: unknown;
  let turnTrust: unknown;

  const conversation = {
    conversationId: forkId,
    agentLoop,
    provider: scriptedProvider,
    usageStats: {},
    messages,
    // The wake trims its own run input; nothing here is tagged as a camera
    // frame, so the real pass would return the array unchanged too.
    trimAgedSightFrames: (msgs: Message[]) => msgs,
    getMessages: () => messages,
    isProcessing: () => processing,
    setProcessing: (on: boolean) => {
      processing = on;
    },
    waitForIdle: async () => true,
    get subagentAllowedTools() {
      return activeAllowedTools;
    },
    setSubagentAllowedTools: (tools: Set<string> | undefined) => {
      activeAllowedTools = tools;
    },
    preactivatedSkillIds: undefined,
    setPreactivatedSkillIds: () => {},
    subagentToolGateMode: undefined,
    toolContextPin: undefined,
    currentTurnRequestOrigin: undefined,
    wakePersonaOverride: undefined,
    currentCallSite: undefined,
    currentTurnOverrideProfile: undefined,
    hasNoClient: false,
    get currentTurnTrustContext() {
      return turnTrust;
    },
    set currentTurnTrustContext(value: unknown) {
      turnTrust = value;
    },
    get trustContext() {
      return persistentTrust;
    },
    setTrustContext: (ctx: unknown) => {
      persistentTrust = ctx ?? undefined;
    },
    maybeCompact: async () => null,
    contextWindowManager: {
      estimateInputTokens: () => 1_000,
    },
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    buildCurrentSystemPrompt: () => "chain-test system prompt",
    modelOverride: undefined,
    drainQueue: async () => {},
  };
  return conversation as unknown as Conversation;
}

// ── Module mocks ─────────────────────────────────────────────────────

// Re-export the REAL wake with the conversation resolver injected, so the
// retrospective job's unmodified `wakeAgentForOpportunity(...)` call runs the
// complete production wake logic against the real-AgentLoop double above.
mock.module("../../../../runtime/agent-wake.js", () => ({
  ...realAgentWakeModule,
  wakeAgentForOpportunity: (
    opts: Parameters<typeof realWake>[0],
  ): ReturnType<typeof realWake> =>
    realWake(opts, {
      resolveTarget: async (wakeOpts) =>
        makeForkConversationDouble(wakeOpts.conversationId),
    }),
}));

// Config-lookup leaves outside the state contract under proof.
mock.module("../../../../config/llm-context-resolution.js", () => ({
  resolveEffectiveContextWindow: () => ({ maxInputTokens: 200_000 }),
}));
mock.module("../../../../daemon/conversation-usage.js", () => ({
  recordUsage: () => {},
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

await initializeDb();

// ── Fixtures ─────────────────────────────────────────────────────────

const chainConfig = {
  memory: {
    v2: { enabled: true },
    retrospective: {
      keepSupersededRuns: false,
      matchConversationProfile: false,
      promptPath: null,
      requireUserActivity: false,
      sweepIntervalMs: 8 * 60 * 60 * 1000,
      sweepLookbackMs: 7 * 24 * 60 * 60 * 1000,
    },
  },
  ui: {},
} as unknown as Parameters<typeof runForkBasedRetrospective>[1];

const PRIOR_FACT = "User's cat is named Mochi";

interface ChainFixture {
  sourceId: string;
  priorRetroId: string;
  seededCursorId: string;
  newMessageId: string;
}

/**
 * Stage the full pre-run world in the real DB: a source conversation with
 * processed history, a genuine prior retrospective fork, a seeded state row
 * (cursor + remembered log), and one new unprocessed user message.
 */
async function stageChainFixture(): Promise<ChainFixture> {
  const source = await createConversation("Chain source");
  const first = await addMessage(
    source.id,
    "user",
    JSON.stringify([{ type: "text", text: "Hi, my cat is named Mochi." }]),
  );
  await addMessage(
    source.id,
    "assistant",
    JSON.stringify([{ type: "text", text: "Noted!" }]),
  );

  const prior = await forkConversationForRetrospective({
    conversationId: source.id,
    throughMessageId: first.id,
    source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    title: "Chain source (Retrospective)",
    conversationType: "background",
    groupId: MEMORY_RETROSPECTIVE_GROUP_ID,
  });

  const processedThrough = await addMessage(
    source.id,
    "assistant",
    JSON.stringify([{ type: "text", text: "Anything else?" }]),
  );
  await upsertRetrospectiveState({
    conversationId: source.id,
    lastProcessedMessageId: processedThrough.id,
    lastRunAt: Date.now() - 60 * 60 * 1000,
    rememberedLog: [PRIOR_FACT],
  });

  const fresh = await addMessage(
    source.id,
    "user",
    JSON.stringify([{ type: "text", text: "I just moved to Lisbon." }]),
  );

  return {
    sourceId: source.id,
    priorRetroId: prior.id,
    seededCursorId: processedThrough.id,
    newMessageId: fresh.id,
  };
}

/** Fork conversations currently rooted at the given source. */
function listRetroForksOf(sourceId: string): string[] {
  const db = getDb();
  return db
    .select({ id: conversations.id })
    .from(conversations)
    .all()
    .map((row) => row.id)
    .filter((id) => {
      const conv = getConversation(id);
      return (
        conv?.source === MEMORY_RETROSPECTIVE_FORK_SOURCE &&
        conv.forkParentConversationId === sourceId
      );
    });
}

function resetTables(): void {
  const db = getDb();
  getMemoryDb()!.delete(memoryRetrospectiveState).run();
  getMemoryDb()!.delete(memoryJobs).run();
  db.delete(messagesTable).run();
  db.delete(conversations).run();
}

beforeEach(() => {
  resetTables();
  providerScript = [];
  providerCallCount = 0;
});

// ── Tests ────────────────────────────────────────────────────────────

describe("memory retrospective wake state chain (real AgentLoop)", () => {
  test("provider rejection: no cursor advance, no log mutation, prior kept, fork cleaned up, window retryable", async () => {
    const fixture = await stageChainFixture();
    const stateBefore = getRetrospectiveState(fixture.sourceId);

    // The real loop swallows this into agent_loop_exit("error"); nothing is
    // scripted at the event level.
    providerScript = [
      { reject: new Error("400 this model does not support image input") },
    ];

    const outcome = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );

    expect(outcome.kind).toBe("wake_failed");
    if (outcome.kind === "wake_failed") {
      expect(outcome.reason).toBe("run_error");
    }

    // (1) No successful finalization: cursor and remembered log unchanged.
    const stateAfter = getRetrospectiveState(fixture.sourceId);
    expect(stateAfter?.lastProcessedMessageId).toBe(fixture.seededCursorId);
    expect(stateAfter?.rememberedLog).toEqual([PRIOR_FACT]);
    // Cooldown applies to the failed attempt.
    expect(stateAfter!.lastRunAt).toBeGreaterThan(stateBefore!.lastRunAt!);

    // Prior retrospective (the dedup-baseline fallback) survives.
    expect(getConversation(fixture.priorRetroId)).not.toBeNull();
    // This run's own orphan fork is deleted; the prior is the only fork left.
    expect(listRetroForksOf(fixture.sourceId)).toEqual([fixture.priorRetroId]);

    // (2) The window stays retryable: the same slice succeeds on retry.
    // The finalizer accepts a text-only reply as a completed empty-handed
    // review; a verified remember write is the other accepted evidence.
    providerScript = [{ response: textResponse("Nothing new to save.") }];
    providerCallCount = 0;
    const retry = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );
    expect(retry.kind).toBe("invoked");
    const stateRetried = getRetrospectiveState(fixture.sourceId);
    expect(stateRetried?.lastProcessedMessageId).toBe(fixture.newMessageId);
  });

  test("clean empty reply (HTTP-200, content: []): fails closed, state preserved, window retryable", async () => {
    const fixture = await stageChainFixture();

    // A well-formed provider success whose finalized output is unusable:
    // empty content array, clean end_turn. The real loop exits
    // no_tool_calls; the retrospective's requireUsableOutput turns that
    // into a failed, retryable pass instead of consuming the window.
    providerScript = [
      {
        response: {
          content: [],
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 0 },
          stopReason: "end_turn",
        },
      },
    ];

    const outcome = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );

    expect(outcome.kind).toBe("wake_failed");
    if (outcome.kind === "wake_failed") {
      expect(outcome.reason).toBe("no_output");
    }

    // No finalization: cursor, log, and the prior retrospective untouched;
    // the orphan fork is cleaned up.
    const state = getRetrospectiveState(fixture.sourceId);
    expect(state?.lastProcessedMessageId).toBe(fixture.seededCursorId);
    expect(state?.rememberedLog).toEqual([PRIOR_FACT]);
    expect(getConversation(fixture.priorRetroId)).not.toBeNull();
    expect(listRetroForksOf(fixture.sourceId)).toEqual([fixture.priorRetroId]);

    // The window stays retryable and a usable reply consumes it.
    providerScript = [{ response: textResponse("Nothing new to save.") }];
    providerCallCount = 0;
    const retry = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );
    expect(retry.kind).toBe("invoked");
    expect(
      getRetrospectiveState(fixture.sourceId)?.lastProcessedMessageId,
    ).toBe(fixture.newMessageId);
  });

  test("a paraphrased empty-handed conclusion consumes the window", async () => {
    const fixture = await stageChainFixture();

    // The instruction asks a pass with nothing to save to say so; it does not
    // dictate the sentence. The real loop ends this run on `no_tool_calls`,
    // which is what proves the model reached its own conclusion.
    providerScript = [
      { response: textResponse("Nothing further to save, all covered above.") },
    ];

    const outcome = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind === "invoked") {
      expect(outcome.noFindings).toBe(true);
    }
    const state = getRetrospectiveState(fixture.sourceId);
    expect(state?.lastProcessedMessageId).toBe(fixture.newMessageId);
    // A pass that saved nothing adds nothing to the dedup baseline.
    expect(state?.rememberedLog).toEqual([PRIOR_FACT]);
  });

  test("usable-output control: cursor advances, remembered log grows, prior retrospective is GC'd", async () => {
    const fixture = await stageChainFixture();

    providerScript = [
      { response: rememberToolUseResponse("User moved to Lisbon") },
      { response: textResponse("Saved the move to memory.") },
    ];

    const outcome = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind === "invoked") {
      expect(outcome.cutoffMessageId).toBe(fixture.newMessageId);
      expect(outcome.noFindings).toBe(false);
    }

    // (3) Real finalization against real rows: cursor advanced, this run's
    // remember (extracted from the fork's persisted tail) appended to the
    // cumulative log, superseded prior GC'd.
    const state = getRetrospectiveState(fixture.sourceId);
    expect(state?.lastProcessedMessageId).toBe(fixture.newMessageId);
    expect(state?.rememberedLog).toEqual([PRIOR_FACT, "User moved to Lisbon"]);
    expect(getConversation(fixture.priorRetroId)).toBeNull();
  });

  test("rejection after a live checkpoint stays invoked: landed side effects are honored", async () => {
    const fixture = await stageChainFixture();

    // First call: a full remember tool round (checkpoint goes live and the
    // tail is persisted). Second call: provider rejection, swallowed by the
    // real loop into a no-output stop.
    providerScript = [
      { response: rememberToolUseResponse("User moved to Lisbon") },
      { reject: new Error("500 provider died mid-run") },
    ];

    const outcome = await runForkBasedRetrospective(
      fixture.sourceId,
      chainConfig,
    );

    // (4) The run's `remember` executed, so it must not read as skipped:
    // the wake reports invoked and finalization honors the landed work.
    expect(outcome.kind).toBe("invoked");
    const state = getRetrospectiveState(fixture.sourceId);
    expect(state?.lastProcessedMessageId).toBe(fixture.newMessageId);
    expect(state?.rememberedLog).toEqual([PRIOR_FACT, "User moved to Lisbon"]);
  });
});
