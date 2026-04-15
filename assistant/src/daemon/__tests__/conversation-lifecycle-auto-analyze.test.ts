/**
 * Unit tests for the auto-analysis enqueue branch in `disposeConversation()`.
 *
 * `disposeConversation` fires two end-of-conversation enqueues for guardian
 * conversations: the existing `graph_extract` job (memory extraction) and the
 * new `conversation_analyze` job (auto-analysis loop, gated by the
 * `auto-analyze` feature flag and source-type guard).
 *
 * We stub the downstream enqueue helpers and the side-effecting lifecycle
 * deps (hook manager, notifier/skill cleanup, browser-screencast) so the test
 * can invoke `disposeConversation` with a minimal `DisposeContext` and assert
 * on the enqueue bookkeeping alone.
 *
 * Recursion guard — when the source conversation is itself an auto-analysis
 * conversation — is enforced inside `enqueueAutoAnalysisIfEnabled` (PR 12),
 * not here. We stub that helper to simulate "flag enabled / flag disabled /
 * recursion guard hit" states.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

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

const realJobsStore = await import("../../memory/jobs-store.js");
mock.module("../../memory/jobs-store.js", () => ({
  ...realJobsStore,
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    memoryJobCalls.push({ type, payload });
    return "job-id";
  },
}));

mock.module("../../memory/auto-analysis-enqueue.js", () => ({
  enqueueAutoAnalysisIfEnabled: (args: {
    conversationId: string;
    trigger: "batch" | "idle" | "lifecycle";
  }) => {
    if (!autoAnalyzeEnabled) return;
    autoAnalyzeCalls.push(args);
  },
}));

// Stub all side-effecting cleanup helpers that disposeConversation chains
// into after the enqueue block. We assert on enqueue behavior only.
mock.module("../../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: () => undefined,
  }),
}));

mock.module("../../tools/browser/browser-screencast.js", () => ({
  unregisterConversationSender: () => {},
}));

mock.module("../conversation-notifiers.js", () => ({
  unregisterCallNotifiers: () => {},
  unregisterWatchNotifiers: () => {},
}));

mock.module("../conversation-skill-tools.js", () => ({
  resetSkillToolProjection: () => {},
}));

// Dynamic import after mock.module calls so stubs take effect.
const { disposeConversation } = await import("../conversation-lifecycle.js");
type DisposeContext = import("../conversation-lifecycle.js").DisposeContext;
type TrustClass =
  import("../../runtime/actor-trust-resolver.js").TrustClass;

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
    autoAnalyzeEnabled = true;
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
    // code short-circuits on `isUntrustedTrustClass()` so neither enqueue
    // path should fire. This preserves the memory trust boundary.
    const ctx = makeDisposeContext({
      conversationId: "conv-untrusted",
      trustClass: "unknown",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  test("auto-analysis conversation (recursion guard) — helper no-ops, so only graph_extract is enqueued", () => {
    // The recursion guard lives inside `enqueueAutoAnalysisIfEnabled` (it
    // checks `isAutoAnalysisConversation()`). From disposeConversation's
    // vantage point the helper simply no-ops. We simulate that by flipping
    // the shared flag — the stubbed helper respects it.
    //
    // graph_extract still fires here; suppressing graph_extract for
    // auto-analysis conversations is a separate concern and not gated by
    // this helper.
    autoAnalyzeEnabled = false;
    const ctx = makeDisposeContext({
      conversationId: "conv-auto",
      trustClass: "guardian",
    });

    disposeConversation(ctx);

    expect(memoryJobCalls).toHaveLength(1);
    expect(memoryJobCalls[0]!.type).toBe("graph_extract");
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

  test("helper throws — disposal continues (best-effort semantics)", () => {
    // The try/catch around `enqueueAutoAnalysisIfEnabled` must swallow
    // errors so a broken helper never blocks disposal. We verify by
    // swapping in a throwing stub for a single call and confirming
    // disposeConversation itself does not throw.
    const originalEnabled = autoAnalyzeEnabled;
    autoAnalyzeEnabled = true;

    // Temporarily re-mock the helper to throw.
    mock.module("../../memory/auto-analysis-enqueue.js", () => ({
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
    mock.module("../../memory/auto-analysis-enqueue.js", () => ({
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
});
