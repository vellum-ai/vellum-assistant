/**
 * Tests for `startVoiceTurn`'s conversation-lock wait.
 *
 * The bridge waits on `conversation.waitForIdle` (event-driven, resolved
 * from `setProcessing(false)`) instead of polling `isProcessing()` every
 * 50 ms, so a barge-in turn starts on the same tick the prior turn releases
 * the lock. The call-controller re-prompt path matches on the exact error
 * strings, so those are pinned here too. `waitForIdle`'s own semantics are
 * covered by `src/__tests__/conversation-wait-for-idle.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing voice-session-bridge
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    workspaceGit: { turnCommitMaxWaitMs: 100 },
    calls: {},
  }),
}));

// Swapped per-test to hand startVoiceTurn a scripted fake conversation.
let fakeConversation: FakeConversation;

mock.module("../../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => fakeConversation,
}));

import { ABORT_WATCHDOG_MS } from "../../daemon/abort-watchdog.js";
import { CALL_OPENING_MARKER } from "../voice-control-protocol.js";
import { startVoiceTurn } from "../voice-session-bridge.js";

// ---------------------------------------------------------------------------
// Fake conversation
// ---------------------------------------------------------------------------

interface WaitForIdleCall {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface FakeConversation {
  conversationId: string;
  callSessionId: string | undefined;
  forcePromptSideEffects: boolean;
  currentRequestId: string | undefined;
  isProcessing: () => boolean;
  waitForIdle: (options: WaitForIdleCall) => Promise<boolean>;
  setAssistantId: (id: string) => void;
  setTrustContext: (ctx: unknown) => void;
  setCommandIntent: (intent: unknown) => void;
  setTurnChannelContext: (ctx: unknown) => void;
  setTurnInterfaceContext: (ctx: unknown) => void;
  setChannelCapabilities: (caps: unknown) => void;
  setVoiceCallControlPrompt: (prompt: string | null) => void;
  persistUserMessage: (opts: {
    content: string;
    requestId: string;
  }) => Promise<{ id: string }>;
  updateClient: (cb: unknown, reset?: boolean) => void;
  runAgentLoop: (...args: unknown[]) => Promise<void>;
  abort: (reason?: unknown) => void;
}

function makeFakeConversation(opts: {
  processing: boolean;
  waitForIdle?: (options: WaitForIdleCall) => Promise<boolean>;
  runAgentLoop?: () => Promise<void>;
  events?: string[];
}) {
  const waitForIdleCalls: WaitForIdleCall[] = [];
  let persistCount = 0;
  const conversation: FakeConversation = {
    conversationId: "conv-voice-bridge-test",
    callSessionId: undefined,
    forcePromptSideEffects: false,
    currentRequestId: undefined,
    isProcessing: () => opts.processing,
    waitForIdle: (options) => {
      waitForIdleCalls.push(options);
      if (!opts.waitForIdle) {
        throw new Error("waitForIdle not scripted for this test");
      }
      return opts.waitForIdle(options);
    },
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setChannelCapabilities: () => {},
    setVoiceCallControlPrompt: () => {},
    persistUserMessage: async () => {
      persistCount += 1;
      opts.events?.push("persist");
      return { id: `msg-${persistCount}` };
    },
    // The install (reset falsy) / reset (reset true) pair marks a turn
    // taking ownership of the conversation vs a turn's cleanup releasing it.
    updateClient: (_cb, reset) => {
      opts.events?.push(reset ? "client:reset" : "client:install");
    },
    runAgentLoop: () => (opts.runAgentLoop ?? (async () => {}))(),
    abort: () => {},
  };
  return {
    conversation,
    waitForIdleCalls,
    persistCount: () => persistCount,
    setProcessingFlag: (value: boolean) => {
      opts.processing = value;
    },
  };
}

function makeTurnOptions(signal?: AbortSignal, conversationId?: string) {
  return {
    conversationId: conversationId ?? "conv-voice-bridge-test",
    // The synthetic opener marker keeps the turn off the user-echo
    // broadcast path (no event-hub / persisted-seq side effects in tests).
    content: CALL_OPENING_MARKER,
    isInbound: true,
    signal,
  };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startVoiceTurn conversation-lock wait", () => {
  test("an idle conversation starts the turn without consulting waitForIdle", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    const handle = await startVoiceTurn(makeTurnOptions());

    expect(handle.turnId).toBeString();
    expect(fake.waitForIdleCalls.length).toBe(0);
    expect(fake.persistCount()).toBe(1);
  });

  test("the turn starts on the same tick the prior turn releases the lock", async () => {
    let release!: (idle: boolean) => void;
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(0);

    // Release the lock, then flush ONLY microtasks — no timers. The old
    // 50 ms poll loop could not reach persistUserMessage this way.
    release(true);
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(1);

    await turnPromise;
  });

  test("passes the full processing-wait budget and the abort signal to waitForIdle", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => true,
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(controller.signal));

    expect(fake.waitForIdleCalls.length).toBe(1);
    // turnCommitMaxWaitMs (100, from the config mock) + abort watchdog +
    // 1000 ms margin — see resolveProcessingWaitMs.
    expect(fake.waitForIdleCalls[0]!.timeoutMs).toBe(
      100 + ABORT_WATCHDOG_MS + 1000,
    );
    expect(fake.waitForIdleCalls[0]!.signal).toBe(controller.signal);
  });

  test("a timed-out wait throws the exact already-processing error", async () => {
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => false,
    });
    fakeConversation = fake.conversation;

    await expect(startVoiceTurn(makeTurnOptions())).rejects.toThrow(
      "Conversation is already processing a message",
    );
    expect(fake.persistCount()).toBe(0);
  });

  test("an abort mid-wait throws the exact turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: ({ signal }) =>
        new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn(makeTurnOptions(controller.signal));
    // Let the turn reach the waitForIdle suspension point, then abort.
    await flushMicrotasks();
    controller.abort();
    await expect(turnPromise).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(fake.persistCount()).toBe(0);
  });

  test("a signal aborted despite the lock releasing still throws the turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => {
        // The lock released and the abort landed in the same window: the
        // bridge must still honor the abort rather than start the turn.
        controller.abort();
        return true;
      },
    });
    fakeConversation = fake.conversation;

    await expect(
      startVoiceTurn(makeTurnOptions(controller.signal)),
    ).rejects.toThrow("Turn aborted while waiting for conversation");
    expect(fake.persistCount()).toBe(0);
  });
});

describe("startVoiceTurn prior-turn teardown barrier", () => {
  test("the next turn waits for the prior turn's cleanup before installing its state", async () => {
    const events: string[] = [];
    let releaseAgentLoop!: () => void;
    const fake = makeFakeConversation({
      // The processing flag is already false — modeling the window after
      // `setProcessing(false)` fired the idle waiters but before the prior
      // turn's agent-loop continuation ran `finally { cleanup() }`.
      processing: false,
      events,
      runAgentLoop: () =>
        new Promise<void>((resolve) => {
          releaseAgentLoop = resolve;
        }),
    });
    fakeConversation = fake.conversation;

    // Turn 1 starts and suspends inside its agent loop.
    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-order"));
    await flushMicrotasks();
    expect(events).toEqual(["persist", "client:install"]);

    // Turn 2 arrives during the teardown window: it must not persist or
    // install its client callback until turn 1's cleanup has run.
    const turn2 = startVoiceTurn(
      makeTurnOptions(undefined, "conv-teardown-order"),
    );
    await flushMicrotasks();
    expect(events).toEqual(["persist", "client:install"]);

    releaseAgentLoop();
    await flushMicrotasks();
    await turn2;
    // Turn 1's cleanup (client:reset) strictly precedes turn 2's persist
    // and install — the state clobber the barrier exists to prevent.
    expect(events).toEqual([
      "persist",
      "client:install",
      "client:reset",
      "persist",
      "client:install",
    ]);
  });

  test("a queued drain that retakes the lock after teardown is also waited out", async () => {
    let releaseAgentLoop!: () => void;
    const fake = makeFakeConversation({
      processing: false,
      runAgentLoop: () =>
        new Promise<void>((resolve) => {
          releaseAgentLoop = resolve;
        }),
      // The prior turn's queued-message drain holds the lock when turn 2
      // clears the teardown barrier; waitForIdle releases it.
      waitForIdle: async () => {
        fake.setProcessingFlag(false);
        return true;
      },
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-requeue"));
    expect(fake.persistCount()).toBe(1);

    const turn2 = startVoiceTurn(
      makeTurnOptions(undefined, "conv-teardown-requeue"),
    );
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(1);

    // The drain retakes the lock in the same window the teardown settles.
    fake.setProcessingFlag(true);
    releaseAgentLoop();
    await flushMicrotasks();
    await turn2;

    // Turn 2 consulted waitForIdle for the retaken lock instead of
    // failing inside persistUserMessage.
    expect(fake.waitForIdleCalls.length).toBe(1);
    expect(fake.persistCount()).toBe(2);
  });

  test("an abort while waiting on a wedged prior teardown throws the turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: false,
      // Wedged: the prior turn's agent loop never settles, so its
      // teardown never runs.
      runAgentLoop: () => new Promise<void>(() => {}),
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-wedged"));
    expect(fake.persistCount()).toBe(1);

    const turn2 = startVoiceTurn(
      makeTurnOptions(controller.signal, "conv-teardown-wedged"),
    );
    await flushMicrotasks();
    controller.abort();
    await expect(turn2).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(fake.persistCount()).toBe(1);
  });
});
