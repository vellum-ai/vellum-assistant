/**
 * Unit tests for the auto-analysis enqueue branch in `disposeConversation()`.
 *
 * `disposeConversation` fires two end-of-conversation enqueues for guardian
 * conversations: the existing `graph_extract` job (memory extraction) and the
 * new `conversation_analyze` job (auto-analysis loop, gated by the
 * `auto-analyze` feature flag and source-type guard).
 *
 * We stub the downstream enqueue helpers and the side-effecting lifecycle
 * deps (notifier/skill cleanup, browser-screencast) so the test can invoke
 * `disposeConversation` with a minimal `DisposeContext` and assert on the
 * enqueue bookkeeping alone.
 *
 * Two recursion guards apply when the source conversation is itself an
 * auto-analysis conversation:
 *   1. `enqueueAutoAnalysisIfEnabled` short-circuits internally,
 *      preventing the analyzer from analyzing its own output.
 *   2. `disposeConversation` skips `graph_extract` directly via
 *      `isAutoAnalysisConversation()`, mirroring the guard the indexer
 *      applies on the per-message path. The analysis agent writes memory
 *      directly via tools, so extracting its reflective musings would
 *      double-write the graph.
 * We stub both the helper and the guard so the test can simulate "flag
 * enabled / flag disabled / source is auto-analysis" states.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => createMockLoggerModule());

// ---------------------------------------------------------------------------
// Mock state — reset between tests.
// ---------------------------------------------------------------------------

const memoryJobCalls: Array<{
  type: string;
  payload: Record<string, unknown>;
}> = [];
const autoAnalyzeCalls: Array<{
  conversationId: string;
  trigger: "batch" | "idle" | "lifecycle";
}> = [];

// Simulates the helper's "flag off / recursion guard" behavior by no-op-ing
// when `autoAnalyzeEnabled` is false. When true, we record the call so the
// test can assert the trigger and conversation id.
let autoAnalyzeEnabled = true;

// Tracks whether the conversation under test should be treated as an
// auto-analysis source by `isAutoAnalysisConversation`. When true,
// `disposeConversation` must skip the `graph_extract` enqueue.
const autoAnalysisConversations = new Set<string>();

// Toggles the `memory.v2.enabled` flag the disposal code reads via
// `getConfig()`. Defaults to false so the bulk of the suite — which asserts
// v1 graph_extract still fires — keeps its semantics. The dedicated v2 cases
// flip this to true.
let v2Enabled = false;

const realLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => ({ memory: { v2: { enabled: v2Enabled } } }),
  loadConfig: () => ({ memory: { v2: { enabled: v2Enabled } } }),
}));

mock.module("../../runtime/services/auto-analysis-guard.js", () => ({
  AUTO_ANALYSIS_SOURCE: "auto-analysis",
  isAutoAnalysisConversation: (conversationId: string) =>
    autoAnalysisConversations.has(conversationId),
}));

const realJobsStore = await import("../../persistence/jobs-store.js");
mock.module("../../persistence/jobs-store.js", () => ({
  ...realJobsStore,
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    memoryJobCalls.push({ type, payload });
    return "job-id";
  },
}));

const realAutoAnalysisEnqueue =
  await import("../../runtime/services/auto-analysis-enqueue.js");
mock.module("../../runtime/services/auto-analysis-enqueue.js", () => ({
  ...realAutoAnalysisEnqueue,
  enqueueAutoAnalysisIfEnabled: (args: {
    conversationId: string;
    trigger: "batch" | "idle" | "lifecycle";
  }) => {
    if (!autoAnalyzeEnabled) return;
    autoAnalyzeCalls.push(args);
  },
}));

const memoryRetroCalls: Array<{
  conversationId: string;
  trigger: string;
}> = [];

mock.module(
  "../../plugins/defaults/memory/memory-retrospective-enqueue.js",
  () => ({
    enqueueMemoryRetrospectiveIfEnabled: (args: {
      conversationId: string;
      trigger: string;
    }) => {
      memoryRetroCalls.push(args);
    },
    // Also export sibling functions other modules import from this file, so
    // mocking it here doesn't break transitive imports loaded during the
    // `disposeConversation` dynamic-import chain.
    enqueueMemoryRetrospectiveOnCompaction: () => {},
    isMemoryRetrospectiveConversation: (_id: string) => false,
  }),
);

// Stub all side-effecting cleanup helpers that disposeConversation chains
// into after the enqueue block. We assert on enqueue behavior only.
const realBrowserScreencast =
  await import("../../tools/browser/browser-screencast.js");
mock.module("../../tools/browser/browser-screencast.js", () => ({
  ...realBrowserScreencast,
  unregisterConversationSender: () => {},
}));

const realConversationNotifiers = await import("../conversation-notifiers.js");
mock.module("../conversation-notifiers.js", () => ({
  ...realConversationNotifiers,
  unregisterCallNotifiers: () => {},
}));

const realConversationSkillTools =
  await import("../conversation-skill-tools.js");
mock.module("../conversation-skill-tools.js", () => ({
  ...realConversationSkillTools,
  resetSkillToolProjection: () => {},
}));

// Dynamic import after mock.module calls so stubs take effect.
const { disposeConversation } = await import("../conversation-lifecycle.js");
type DisposeContext = import("../conversation-lifecycle.js").DisposeContext;
type TrustClass = import("../../runtime/actor-trust-resolver.js").TrustClass;

// ---------------------------------------------------------------------------
// Fixture builder — minimal DisposeContext satisfying the interface shape.
// ---------------------------------------------------------------------------

function makeDisposeContext(
  overrides: {
    conversationId?: string;
    trustClass?: TrustClass;
  } = {},
): DisposeContext {
  const eventBus = { dispose: () => {} };
  const profiler = { clear: () => {} };
  const abortController = { abort: () => {} };
  const queue = {
    clear: () => {},
    [Symbol.iterator]: function* () {
      // empty queue — no queued messages to cancel during disposal.
    },
  };
  const prompter = { dispose: () => {} };
  const secretPrompter = { dispose: () => {} };

  const ctx = {
    conversationId: overrides.conversationId ?? "conv-1",
    processing: false,
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setProcessing(this: { processing: boolean }, value: boolean) {
      this.processing = value;
    },
    abortController,
    prompter,
    secretPrompter,
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    surfaceState: new Map(),
    accumulatedSurfaceState: new Map(),
    queue,
    eventBus,
    skillProjectionState: new Map<string, string>(),
    profiler,
    messages: [],
    surfaceUndoStacks: new Map<string, string[]>(),
    currentTurnSurfaces: [] as Array<unknown>,
    lastSurfaceAction: new Map<string, unknown>(),
    workspaceTopLevelContext: null,
    ...(overrides.trustClass
      ? { trustContext: { trustClass: overrides.trustClass } }
      : {}),
    abort(): void {},
  };

  return ctx as unknown as DisposeContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("disposeConversation — auto-analysis enqueue", () => {
  beforeEach(() => {
    memoryJobCalls.length = 0;
    autoAnalyzeCalls.length = 0;
    memoryRetroCalls.length = 0;
    autoAnalyzeEnabled = true;
    autoAnalysisConversations.clear();
    v2Enabled = false;
  });

  test("guardian conversation with auto-analyze ON — enqueues both graph_extract and conversation_analyze (via helper)", () => {
    autoAnalyzeEnabled = true;
    const ctx = makeDisposeContext({
      conversationId: "conv-guardian",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    // graph_extract fires unchanged.
    expect(memoryJobCalls).toHaveLength(1);
    expect(memoryJobCalls[0]!.type).toBe("graph_extract");
    expect(memoryJobCalls[0]!.payload).toMatchObject({
      conversationId: "conv-guardian",
    });

    // Auto-analysis helper is invoked with trigger "lifecycle".
    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(autoAnalyzeCalls[0]).toEqual({
      conversationId: "conv-guardian",
      trigger: "lifecycle",
    });
  });

  test("untrusted conversation — enqueues neither graph_extract nor conversation_analyze", () => {
    // `unknown` is the trust class used for untrusted actors. The disposal
    // code short-circuits when `resolveCapabilities(trustClass).canAccessMemory`
    // is false, so neither enqueue path should fire. This preserves the
    // memory trust boundary.
    const ctx = makeDisposeContext({
      conversationId: "conv-untrusted",
      trustClass: "unknown",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  test("auto-analysis conversation — neither graph_extract nor conversation_analyze is enqueued", () => {
    // Two recursion guards apply when the source conversation is itself an
    // auto-analysis conversation:
    //   1. `disposeConversation` skips the `graph_extract` enqueue directly
    //      via `isAutoAnalysisConversation()` — mirroring the indexer's
    //      per-message guard. Without this, evicting an auto-analysis
    //      conversation from the LRU would double-write the memory graph
    //      because the analysis agent already writes memory via tools.
    //   2. `enqueueAutoAnalysisIfEnabled` no-ops internally for
    //      auto-analysis conversations (its own recursion guard). We
    //      simulate that by flipping `autoAnalyzeEnabled` off.
    autoAnalysisConversations.add("conv-auto");
    autoAnalyzeEnabled = false;
    const ctx = makeDisposeContext({
      conversationId: "conv-auto",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  test("auto-analyze flag OFF — helper no-ops, so only graph_extract is enqueued", () => {
    // When the `auto-analyze` feature flag is disabled, the helper returns
    // early without enqueuing. We simulate that by flipping the shared flag.
    autoAnalyzeEnabled = false;
    const ctx = makeDisposeContext({
      conversationId: "conv-flag-off",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(1);
    expect(memoryJobCalls[0]!.type).toBe("graph_extract");
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  test("isAutoAnalysisConversation throws — fails open, still enqueues graph_extract and continues disposal", () => {
    // If the DB read inside `isAutoAnalysisConversation` throws (e.g. SQLite
    // unavailable during teardown), disposal must not abort. We fail open:
    // default to NOT skipping, so graph_extract still fires and the rest of
    // the cleanup chain runs.
    autoAnalyzeEnabled = true;

    mock.module("../../runtime/services/auto-analysis-guard.js", () => ({
      AUTO_ANALYSIS_SOURCE: "auto-analysis",
      isAutoAnalysisConversation: () => {
        throw new Error("db closed");
      },
    }));

    const ctx = makeDisposeContext({
      conversationId: "conv-guard-throws",
      trustClass: "guardian",
    });

    expect(() => disposeConversation(ctx)).not.toThrow();

    // Fail-open: graph_extract fires even though the guard threw.
    expect(memoryJobCalls).toHaveLength(1);
    expect(memoryJobCalls[0]!.type).toBe("graph_extract");
    // The auto-analyze helper also still runs (separate try/catch).
    expect(autoAnalyzeCalls).toHaveLength(1);

    // Restore the non-throwing stub for subsequent tests.
    mock.module("../../runtime/services/auto-analysis-guard.js", () => ({
      AUTO_ANALYSIS_SOURCE: "auto-analysis",
      isAutoAnalysisConversation: (conversationId: string) =>
        autoAnalysisConversations.has(conversationId),
    }));
  });

  test("helper throws — disposal continues (best-effort semantics)", () => {
    // The try/catch around `enqueueAutoAnalysisIfEnabled` must swallow
    // errors so a broken helper never blocks disposal. We verify by
    // swapping in a throwing stub for a single call and confirming
    // disposeConversation itself does not throw.
    const originalEnabled = autoAnalyzeEnabled;
    autoAnalyzeEnabled = true;

    // Temporarily re-mock the helper to throw.
    mock.module("../../runtime/services/auto-analysis-enqueue.js", () => ({
      enqueueAutoAnalysisIfEnabled: () => {
        throw new Error("boom");
      },
    }));

    const ctx = makeDisposeContext({
      conversationId: "conv-throw",
      trustClass: "guardian",
    });

    expect(() => disposeConversation(ctx)).not.toThrow();

    // graph_extract still fired before the throw.
    expect(memoryJobCalls).toHaveLength(1);

    // Restore the non-throwing stub so other tests aren't affected.
    mock.module("../../runtime/services/auto-analysis-enqueue.js", () => ({
      enqueueAutoAnalysisIfEnabled: (args: {
        conversationId: string;
        trigger: "batch" | "idle" | "lifecycle";
      }) => {
        if (!autoAnalyzeEnabled) return;
        autoAnalyzeCalls.push(args);
      },
    }));
    autoAnalyzeEnabled = originalEnabled;
  });

  test("memory v2 enabled — graph_extract enqueue is suppressed (auto-analysis still runs)", () => {
    // Under memory v2, the v1 graph has no readers (retrieval is bypassed at
    // conversation-graph-memory.ts), so producing extraction jobs just fills
    // the queue with stale work. Auto-analysis is orthogonal and must keep
    // running.
    v2Enabled = true;
    const ctx = makeDisposeContext({
      conversationId: "conv-v2-on",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(0);
    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(autoAnalyzeCalls[0]).toEqual({
      conversationId: "conv-v2-on",
      trigger: "lifecycle",
    });
  });
});

describe("disposeConversation — memory-retrospective lifecycle safety net", () => {
  beforeEach(() => {
    memoryJobCalls.length = 0;
    autoAnalyzeCalls.length = 0;
    memoryRetroCalls.length = 0;
    autoAnalyzeEnabled = false;
    autoAnalysisConversations.clear();
    v2Enabled = false;
  });

  test("guardian conversation — enqueues memory-retrospective with trigger 'lifecycle'", () => {
    const ctx = makeDisposeContext({
      conversationId: "conv-retro",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryRetroCalls).toHaveLength(1);
    expect(memoryRetroCalls[0]).toEqual({
      conversationId: "conv-retro",
      trigger: "lifecycle",
    });
  });

  test("untrusted actor — no memory-retrospective enqueue", () => {
    const ctx = makeDisposeContext({
      conversationId: "conv-retro-untrusted",
      trustClass: "unknown",
    });

    disposeConversation(ctx);

    // The outer trust-class guard in disposeConversation gates ALL three
    // enqueues (graph_extract, auto-analyze, memory-retrospective). When
    // the actor is untrusted, none of them fire.
    expect(memoryRetroCalls).toHaveLength(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  // Regression test: the retrospective lifecycle enqueue was previously
  // outside the `!isAutoAnalysis` guard, so it fired even for auto-analysis
  // conversations. Mirrors the indexer-time gate in `indexer.ts` and
  // matches the existing graph_extract recursion-guard semantics.
  test("auto-analysis conversation — does NOT enqueue memory-retrospective", () => {
    autoAnalysisConversations.add("conv-auto-retro");
    const ctx = makeDisposeContext({
      conversationId: "conv-auto-retro",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryRetroCalls).toHaveLength(0);
    // graph_extract is also recursion-guarded by the same `!isAutoAnalysis`
    // block, so it should be skipped here too.
    expect(memoryJobCalls).toHaveLength(0);
  });
});
