/**
 * Tests for `wakeAgentForOpportunity()` — the generic internal agent-wake
 * mechanism.
 *
 * Exercise strategy: the wake helper takes a `resolveTarget` dependency so
 * these tests stub out the heavyweight `Conversation` class with a minimal
 * `WakeTarget` that just tracks agent-event forwards, buffered messages,
 * persisted tail messages, drain invocations, and a scripted
 * `agentLoop.run()` response.
 *
 * Persistence is now delegated to `WakeTarget.persistTailMessage` (the
 * daemon adapter is responsible for building channel/interface metadata
 * and disk-view sync — out of scope for runtime tests), so we assert on
 * the calls received by the mock instead of stubbing
 * `memory/conversation-crud.js`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../../agent/loop.js";
import type { Message } from "../../providers/types.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeTarget,
} from "../agent-wake.js";

// ── Test helpers ─────────────────────────────────────────────────────

interface MockTarget extends WakeTarget {
  emittedEvents: AgentEvent[];
  pushedMessages: Message[];
  runCalls: Array<{ input: Message[]; requestId?: string }>;
  processingToggles: boolean[];
  /** Tail messages handed to `persistTailMessage`, in call order. */
  persistedTailCalls: Message[];
  /** Number of times `drainQueue` was invoked. */
  drainQueueCalls: number;
  /**
   * Cross-hook call sequence tag. Each push/persist/drain (and the
   * processing toggles that bracket them) appends an entry so tests can
   * assert end-to-end ordering, not just per-hook counts.
   */
  callSequence: string[];
  /**
   * Snapshot of `processing` at the moment `drainQueue` was invoked.
   * Lets tests prove drain ran AFTER markProcessing(false), rather than
   * just inferring it from the order of recorded toggles.
   */
  processingDuringDrain: boolean[];
}

function makeTarget(options: {
  conversationId?: string;
  baseline?: Message[];
  scriptedAssistant?: Message | null;
  /** Extra tail messages appended *after* `scriptedAssistant` (e.g. tool_result, follow-up assistant). */
  scriptedTail?: Message[];
  scriptedEvents?: AgentEvent[];
  isProcessing?: boolean;
  /** When true, omit `drainQueue` so we can verify the wake handles its absence. */
  omitDrainQueue?: boolean;
}): MockTarget {
  const emittedEvents: AgentEvent[] = [];
  const pushedMessages: Message[] = [];
  const runCalls: Array<{ input: Message[]; requestId?: string }> = [];
  const processingToggles: boolean[] = [];
  const persistedTailCalls: Message[] = [];
  const callSequence: string[] = [];
  const processingDuringDrain: boolean[] = [];
  const history: Message[] = [...(options.baseline ?? [])];
  let processing = options.isProcessing ?? false;
  let drainQueueCalls = 0;

  const target: MockTarget = {
    conversationId: options.conversationId ?? "conv-test",
    emittedEvents,
    pushedMessages,
    runCalls,
    processingToggles,
    persistedTailCalls,
    callSequence,
    processingDuringDrain,
    get drainQueueCalls() {
      return drainQueueCalls;
    },
    agentLoop: {
      run: async (
        input: Message[],
        onEvent: (event: AgentEvent) => void | Promise<void>,
        _signal?: AbortSignal,
        requestId?: string,
      ) => {
        runCalls.push({ input: [...input], requestId });
        // Emit any scripted events the test wanted us to produce.
        for (const ev of options.scriptedEvents ?? []) {
          await onEvent(ev);
        }
        // Final history = input + optional assistant message + optional tail.
        const next = [...input];
        if (options.scriptedAssistant) {
          next.push(options.scriptedAssistant);
          await onEvent({
            type: "message_complete",
            message: options.scriptedAssistant,
          });
        }
        if (options.scriptedTail) {
          for (const tailMsg of options.scriptedTail) {
            next.push(tailMsg);
          }
        }
        return next;
      },
    },
    getMessages: () => history,
    pushMessage: (msg: Message) => {
      pushedMessages.push(msg);
      history.push(msg);
      callSequence.push("push");
    },
    emitAgentEvent: (event) => {
      emittedEvents.push(event);
    },
    isProcessing: () => processing,
    markProcessing: (on: boolean) => {
      processing = on;
      processingToggles.push(on);
      callSequence.push(on ? "processing:true" : "processing:false");
    },
    persistTailMessage: async (msg: Message) => {
      persistedTailCalls.push(msg);
      callSequence.push("persist");
    },
    ...(options.omitDrainQueue
      ? {}
      : {
          drainQueue: async () => {
            drainQueueCalls++;
            // Snapshot the live processing flag *inside* drain, not via
            // the toggle log, so we directly observe the state visible
            // to the dequeued message's enqueueMessage() gate.
            processingDuringDrain.push(processing);
            callSequence.push("drain");
          },
        }),
  };

  // Expose processing setter via test-only side-channel for tests that
  // simulate an external (non-wake) processing state.
  (target as unknown as { setProcessing: (v: boolean) => void }).setProcessing =
    (v: boolean) => {
      processing = v;
    };

  return target;
}

beforeEach(() => {
  __resetWakeChainForTests();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("wakeAgentForOpportunity", () => {
  test("silent no-op when agent produces no tool calls and no text", async () => {
    const target = makeTarget({
      baseline: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
      // Assistant replies with empty text — counts as no output.
      scriptedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    });

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "someone asked a question",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    // Nothing emitted to client.
    expect(target.emittedEvents).toHaveLength(0);
    // Nothing persisted.
    expect(target.persistedTailCalls).toHaveLength(0);
    // Nothing pushed into live history.
    expect(target.pushedMessages).toHaveLength(0);
    // Hint was included in the run input, but baseline is unchanged.
    expect(target.runCalls).toHaveLength(1);
    const input = target.runCalls[0]!.input;
    expect(input).toHaveLength(3); // 2 baseline + 1 hint
    expect(input[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[opportunity:unit-test] someone asked a question" },
      ],
    });
  });

  test("produces tool calls when LLM emits a tool_use block", async () => {
    const assistantMessage: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "meet_send_chat",
          input: { text: "Sure, here's the link" },
        },
      ],
    };
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: assistantMessage,
    });

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "question directed at assistant",
        source: "meet-chat-opportunity",
      },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: true });
    // Assistant message persisted via the target hook.
    expect(target.persistedTailCalls).toHaveLength(1);
    expect(target.persistedTailCalls[0]).toEqual(assistantMessage);
    // Assistant message pushed into live history.
    expect(target.pushedMessages).toContainEqual(assistantMessage);
    // message_complete event flushed to the client via the translator
    // surface (raw AgentEvent — adapter is responsible for wire shape).
    const flushed = target.emittedEvents.find(
      (e) => e.type === "message_complete",
    );
    expect(flushed).toBeDefined();
  });

  test("persists full multi-turn tail (assistant → tool_result → follow-up assistant)", async () => {
    // Simulate a wake that produces a tool_use, an executed tool_result
    // user message, and a follow-up assistant summary. All three must be
    // persisted; otherwise the next rehydration loses the tool_result
    // and the provider rejects the orphaned tool_use.
    const firstAssistant: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "meet_send_chat",
          input: { text: "Sure" },
        },
      ],
    };
    const toolResultUserMsg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "sent",
        },
      ],
    };
    const followupAssistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };

    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: firstAssistant,
      scriptedTail: [toolResultUserMsg, followupAssistant],
    });

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "question directed at assistant",
        source: "meet-chat-opportunity",
      },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: true });

    // All three tail messages persisted in order via the target hook.
    expect(target.persistedTailCalls).toHaveLength(3);
    expect(target.persistedTailCalls[0]).toEqual(firstAssistant);
    expect(target.persistedTailCalls[1]).toEqual(toolResultUserMsg);
    expect(target.persistedTailCalls[2]).toEqual(followupAssistant);

    // All three also pushed into live history so next turn sees them.
    expect(target.pushedMessages).toHaveLength(3);
    expect(target.pushedMessages[0]).toEqual(firstAssistant);
    expect(target.pushedMessages[1]).toEqual(toolResultUserMsg);
    expect(target.pushedMessages[2]).toEqual(followupAssistant);
  });

  test("marks processing true during the run and false afterwards", async () => {
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
    });

    // Snapshot isProcessing() inside the run to prove we actually
    // hold the processing flag while agentLoop.run executes.
    const observedDuringRun: boolean[] = [];
    const originalRun = target.agentLoop.run;
    target.agentLoop.run = async (input, onEvent, signal, requestId) => {
      observedDuringRun.push(target.isProcessing());
      return originalRun(input, onEvent, signal, requestId);
    };

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "x",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    // markProcessing toggled on then off exactly once.
    expect(target.processingToggles).toEqual([true, false]);
    // And the flag was observed as true inside the run body.
    expect(observedDuringRun).toEqual([true]);
    // Back to idle by the time the wake returns.
    expect(target.isProcessing()).toBe(false);
  });

  test("marks processing false even when the agent loop throws", async () => {
    const history: Message[] = [];
    const toggles: boolean[] = [];
    let processing = false;
    const target: WakeTarget = {
      conversationId: "conv-err-guard",
      agentLoop: {
        run: async () => {
          throw new Error("LLM exploded");
        },
      },
      getMessages: () => history,
      pushMessage: () => {},
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      markProcessing: (on) => {
        processing = on;
        toggles.push(on);
      },
      persistTailMessage: async () => {},
    };

    const result = await wakeAgentForOpportunity(
      { conversationId: "conv-err-guard", hint: "boom", source: "t" },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    // Critical: the finally block must have released the flag despite
    // the thrown error, otherwise the next user turn would hang.
    expect(toggles).toEqual([true, false]);
    expect(processing).toBe(false);
  });

  test("two concurrent wakes on the same conversation are serialized", async () => {
    // Build a target whose agentLoop.run resolves only when we signal.
    const gate1 = Promise.withResolvers<void>();
    const gate2 = Promise.withResolvers<void>();
    const runStartOrder: number[] = [];
    const runCompleteOrder: number[] = [];

    let callIndex = 0;
    const history: Message[] = [];
    let processing = false;
    const target: WakeTarget = {
      conversationId: "conv-serialize",
      agentLoop: {
        run: async (input) => {
          const myIndex = ++callIndex;
          runStartOrder.push(myIndex);
          if (myIndex === 1) {
            await gate1.promise;
          } else {
            await gate2.promise;
          }
          runCompleteOrder.push(myIndex);
          return input; // no assistant message → silent no-op
        },
      },
      getMessages: () => history,
      pushMessage: (msg) => {
        history.push(msg);
      },
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      markProcessing: (on) => {
        processing = on;
      },
      persistTailMessage: async () => {},
    };

    const deps = { resolveTarget: async () => target };

    const p1 = wakeAgentForOpportunity(
      { conversationId: "conv-serialize", hint: "first", source: "t1" },
      deps,
    );
    const p2 = wakeAgentForOpportunity(
      { conversationId: "conv-serialize", hint: "second", source: "t2" },
      deps,
    );

    // Let the microtask queue flush so p1 can start.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runStartOrder).toEqual([1]);

    // Releasing gate2 should NOT let p2 start — it's queued behind p1.
    gate2.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runStartOrder).toEqual([1]);

    // Now release gate1 — p1 completes, then p2 starts and completes.
    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(runStartOrder).toEqual([1, 2]);
    expect(runCompleteOrder).toEqual([1, 2]);
  });

  test("waits while a concurrent user turn is in flight", async () => {
    const history: Message[] = [];
    let processing = true;
    const target: WakeTarget & { setProcessing: (v: boolean) => void } = {
      conversationId: "conv-user-turn",
      agentLoop: {
        run: async (input) => input,
      },
      getMessages: () => history,
      pushMessage: (msg) => {
        history.push(msg);
      },
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      // The wake's own markProcessing updates track the flag too — the
      // outer "user turn" holds it at true until setProcessing(false)
      // is called below.
      markProcessing: (on) => {
        processing = on;
      },
      persistTailMessage: async () => {},
      setProcessing: (v) => {
        processing = v;
      },
    };

    const wakePromise = wakeAgentForOpportunity(
      {
        conversationId: "conv-user-turn",
        hint: "opportunity while user typing",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    // Wake should be waiting (isProcessing returns true).
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Hasn't resolved yet.
    let settled = false;
    void wakePromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // "User turn" completes — wake now proceeds.
    target.setProcessing(false);
    const result = await wakePromise;
    expect(result.invoked).toBe(true);
    expect(result.producedToolCalls).toBe(false);
  });

  test("returns invoked: false when the conversation cannot be resolved", async () => {
    const result = await wakeAgentForOpportunity(
      { conversationId: "missing", hint: "x", source: "y" },
      { resolveTarget: async () => null },
    );
    expect(result).toEqual({ invoked: false, producedToolCalls: false });
  });

  test("agent loop error is treated as a no-op", async () => {
    const history: Message[] = [];
    let processing = false;
    const persisted: Message[] = [];
    const target: WakeTarget = {
      conversationId: "conv-err",
      agentLoop: {
        run: async () => {
          throw new Error("LLM exploded");
        },
      },
      getMessages: () => history,
      pushMessage: () => {},
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      markProcessing: (on) => {
        processing = on;
      },
      persistTailMessage: async (m) => {
        persisted.push(m);
      },
    };

    const result = await wakeAgentForOpportunity(
      { conversationId: "conv-err", hint: "boom", source: "t" },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    expect(persisted).toHaveLength(0);
  });

  test("drainQueue is called in finally after a successful run", async () => {
    // Verifies Gap 1 fix: messages queued during a wake (because the
    // wake set `processing = true`) must be picked up after the wake
    // completes. Mirrors the canonical user-turn `finally` path which
    // sets `processing = false` then calls `drainQueue`.
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
    });

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "x",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(target.drainQueueCalls).toBe(1);
    // Critical ordering invariant: drain runs after processing=false.
    // If drain ran while processing was still true,
    // `enqueueMessage`'s `if (!ctx.processing) return ...` gate would
    // see processing=true and the drained item would itself just
    // re-enqueue — no progress. Snapshot the live flag *inside* drain
    // (rather than inferring from toggle order) so a future regression
    // that called drain before markProcessing(false) would fail this
    // assertion directly.
    expect(target.processingDuringDrain).toEqual([false]);
    expect(target.processingToggles).toEqual([true, false]);
    expect(target.isProcessing()).toBe(false);
  });

  test("drainQueue is called in finally even when the agent loop throws", async () => {
    // Verifies the drain is in the finally block, not just on success.
    // A wake that crashes mid-run must still flush queued messages —
    // otherwise a transient LLM error strands every concurrent send.
    const drainProcessingSnapshots: boolean[] = [];
    const toggles: boolean[] = [];
    let processing = false;
    const target: WakeTarget = {
      conversationId: "conv-drain-on-throw",
      agentLoop: {
        run: async () => {
          throw new Error("LLM exploded mid-wake");
        },
      },
      getMessages: () => [],
      pushMessage: () => {},
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      markProcessing: (on) => {
        processing = on;
        toggles.push(on);
      },
      persistTailMessage: async () => {},
      drainQueue: async () => {
        // Snapshot the live `processing` flag *inside* drain rather
        // than inferring from toggle order. This directly observes the
        // state visible to enqueueMessage's gate when a queued message
        // is dequeued.
        drainProcessingSnapshots.push(processing);
      },
    };

    const result = await wakeAgentForOpportunity(
      { conversationId: "conv-drain-on-throw", hint: "boom", source: "t" },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    // Drain ran AFTER markProcessing(false), satisfying the
    // enqueueMessage gate invariant. Snapshot proves the flag was
    // false at the moment drain ran.
    expect(drainProcessingSnapshots).toEqual([false]);
    expect(toggles).toEqual([true, false]);
  });

  test("missing drainQueue hook is tolerated (no-op fallback)", async () => {
    // The hook is intentionally optional so test stubs without a queue
    // can omit it. Production daemon adapter always wires it.
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
      omitDrainQueue: true,
    });

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "x",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(result.invoked).toBe(true);
    // No throw, no drain attempt recorded.
    expect(target.drainQueueCalls).toBe(0);
  });

  test("drainQueue rejection does not propagate from the wake", async () => {
    // Defense in depth: if the queue drain throws (e.g. a poisoned
    // message), the wake itself must still resolve normally — the
    // drain failure is logged but never surfaced.
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
      },
    });
    target.drainQueue = async () => {
      throw new Error("drain blew up");
    };

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "x",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(result.invoked).toBe(true);
  });

  test("persistTailMessage called for each tail message in order", async () => {
    // Verifies Gap 2 fix: the wake delegates persistence to the target
    // so the daemon adapter can build channel/interface metadata. We
    // only check the call ordering / arguments here — the daemon
    // adapter's metadata composition is exercised separately.
    const firstAssistant: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "some_tool",
          input: {},
        },
      ],
    };
    const toolResultUserMsg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
      ],
    };
    const followup: Message = {
      role: "assistant",
      content: [{ type: "text", text: "All set." }],
    };
    const target = makeTarget({
      baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      scriptedAssistant: firstAssistant,
      scriptedTail: [toolResultUserMsg, followup],
    });

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "x",
        source: "meet-chat-opportunity",
      },
      { resolveTarget: async () => target },
    );

    expect(target.persistedTailCalls).toEqual([
      firstAssistant,
      toolResultUserMsg,
      followup,
    ]);
  });

  test(
    "tail messages are pushed and persisted BEFORE drainQueue runs " +
      "(so dequeued turns see updated history)",
    async () => {
      // Locks in the round-3 fix: a user message queued during the wake
      // is drained against `conversation.messages`, so the wake's tail
      // MUST be appended (push) and persisted to DB (persist) before the
      // queue is drained. Otherwise `drainSingleMessage` reads stale
      // history and writes a DB row that lands out of chronological
      // order (queued user msg before the wake's just-produced
      // assistant outputs).
      //
      // Mirrors the canonical user-turn pattern in
      // conversation-agent-loop.ts:1860,2106-2126: messages updated →
      // processing=false → drainQueue.
      const firstAssistant: Message = {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-1", name: "some_tool", input: {} },
        ],
      };
      const toolResultUserMsg: Message = {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
        ],
      };
      const followup: Message = {
        role: "assistant",
        content: [{ type: "text", text: "All done." }],
      };
      const target = makeTarget({
        baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        scriptedAssistant: firstAssistant,
        scriptedTail: [toolResultUserMsg, followup],
      });

      await wakeAgentForOpportunity(
        {
          conversationId: target.conversationId,
          hint: "x",
          source: "meet-chat-opportunity",
        },
        { resolveTarget: async () => target },
      );

      // Full call sequence: processing toggled true → 3 pushes →
      // 3 persists → processing toggled false → drain. Specifically,
      // every push and every persist must precede the single drain.
      expect(target.callSequence).toEqual([
        "processing:true",
        "push",
        "push",
        "push",
        "persist",
        "persist",
        "persist",
        "processing:false",
        "drain",
      ]);

      // Belt-and-braces: cross-check via index lookups so the failure
      // mode (drain before push/persist) shows up clearly even if the
      // exact sequence ever picks up additional entries.
      const drainIdx = target.callSequence.indexOf("drain");
      const lastPushIdx = target.callSequence.lastIndexOf("push");
      const lastPersistIdx = target.callSequence.lastIndexOf("persist");
      expect(drainIdx).toBeGreaterThan(lastPushIdx);
      expect(drainIdx).toBeGreaterThan(lastPersistIdx);

      // And processing was false when drain ran.
      expect(target.processingDuringDrain).toEqual([false]);
    },
  );

  test(
    "silent no-op: drainQueue still runs (in finally) but nothing is " +
      "pushed, persisted, or emitted",
    async () => {
      // The wake's silent-no-op semantics must be preserved by the
      // round-3 reordering: an empty assistant reply produces no
      // visible text and no tool calls, so no push/persist/emit should
      // happen. drainQueue must still run in the finally block so a
      // racy queued message is not stranded.
      const target = makeTarget({
        baseline: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        scriptedAssistant: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
      });

      await wakeAgentForOpportunity(
        {
          conversationId: target.conversationId,
          hint: "x",
          source: "unit-test",
        },
        { resolveTarget: async () => target },
      );

      // No push, no persist, no emit.
      expect(target.pushedMessages).toHaveLength(0);
      expect(target.persistedTailCalls).toHaveLength(0);
      expect(target.emittedEvents).toHaveLength(0);

      // But drain still ran exactly once, after processing flipped to
      // false. Sequence: toggle true → toggle false → drain.
      expect(target.callSequence).toEqual([
        "processing:true",
        "processing:false",
        "drain",
      ]);
      expect(target.processingDuringDrain).toEqual([false]);
    },
  );
});
