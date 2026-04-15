/**
 * Tests for `wakeAgentForOpportunity()` — the generic internal agent-wake
 * mechanism.
 *
 * Exercise strategy: the wake helper takes a `resolveTarget` dependency so
 * these tests stub out the heavyweight `Conversation` class with a minimal
 * `WakeTarget` that just tracks agent-event forwards, buffered messages,
 * and a scripted `agentLoop.run()` response.
 *
 * The `addMessage` import from `memory/conversation-crud.ts` is stubbed
 * via `mock.module()` so we can assert on persistence without touching a
 * real SQLite DB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../../agent/loop.js";
import type { Message } from "../../providers/types.js";

// ── Stub addMessage so we can assert persistence without a real DB ───

const persistedMessages: Array<{
  conversationId: string;
  role: string;
  content: string;
}> = [];

mock.module("../../memory/conversation-crud.js", () => ({
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
  ) => {
    persistedMessages.push({ conversationId, role, content });
    return { id: `msg-${persistedMessages.length}` };
  },
}));

// Import after the mock is registered.
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
}

function makeTarget(options: {
  conversationId?: string;
  baseline?: Message[];
  scriptedAssistant?: Message | null;
  /** Extra tail messages appended *after* `scriptedAssistant` (e.g. tool_result, follow-up assistant). */
  scriptedTail?: Message[];
  scriptedEvents?: AgentEvent[];
  isProcessing?: boolean;
}): MockTarget {
  const emittedEvents: AgentEvent[] = [];
  const pushedMessages: Message[] = [];
  const runCalls: Array<{ input: Message[]; requestId?: string }> = [];
  const processingToggles: boolean[] = [];
  const history: Message[] = [...(options.baseline ?? [])];
  let processing = options.isProcessing ?? false;

  const target: MockTarget = {
    conversationId: options.conversationId ?? "conv-test",
    emittedEvents,
    pushedMessages,
    runCalls,
    processingToggles,
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
    },
    emitAgentEvent: (event) => {
      emittedEvents.push(event);
    },
    isProcessing: () => processing,
    markProcessing: (on: boolean) => {
      processing = on;
      processingToggles.push(on);
    },
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
  persistedMessages.length = 0;
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
    expect(persistedMessages).toHaveLength(0);
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
    // Assistant message persisted.
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toMatchObject({
      conversationId: target.conversationId,
      role: "assistant",
    });
    expect(JSON.parse(persistedMessages[0]!.content)).toEqual(
      assistantMessage.content,
    );
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

    // All three tail messages persisted in order.
    expect(persistedMessages).toHaveLength(3);
    expect(persistedMessages[0]).toMatchObject({ role: "assistant" });
    expect(JSON.parse(persistedMessages[0]!.content)).toEqual(
      firstAssistant.content,
    );
    expect(persistedMessages[1]).toMatchObject({ role: "user" });
    expect(JSON.parse(persistedMessages[1]!.content)).toEqual(
      toolResultUserMsg.content,
    );
    expect(persistedMessages[2]).toMatchObject({ role: "assistant" });
    expect(JSON.parse(persistedMessages[2]!.content)).toEqual(
      followupAssistant.content,
    );

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
      pushMessage: (msg) => history.push(msg),
      emitAgentEvent: () => {},
      isProcessing: () => processing,
      // The wake's own markProcessing updates track the flag too — the
      // outer "user turn" holds it at true until setProcessing(false)
      // is called below.
      markProcessing: (on) => {
        processing = on;
      },
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
    expect(persistedMessages).toHaveLength(0);
  });

  test("agent loop error is treated as a no-op", async () => {
    const history: Message[] = [];
    let processing = false;
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
    };

    const result = await wakeAgentForOpportunity(
      { conversationId: "conv-err", hint: "boom", source: "t" },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    expect(persistedMessages).toHaveLength(0);
  });
});
