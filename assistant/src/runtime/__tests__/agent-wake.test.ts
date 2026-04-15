/**
 * Tests for `wakeAgentForOpportunity()` — the generic internal agent-wake
 * mechanism.
 *
 * Exercise strategy: the wake helper takes a `resolveTarget` dependency so
 * these tests stub out the heavyweight `Conversation` class with a minimal
 * `WakeTarget` that just tracks buffered messages, emitted events, and a
 * scripted `agentLoop.run()` response.
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
  emittedEvents: unknown[];
  pushedMessages: Message[];
  runCalls: Array<{ input: Message[]; requestId?: string }>;
}

function makeTarget(options: {
  conversationId?: string;
  baseline?: Message[];
  scriptedAssistant?: Message | null;
  scriptedEvents?: AgentEvent[];
  isProcessing?: boolean;
}): MockTarget {
  const emittedEvents: unknown[] = [];
  const pushedMessages: Message[] = [];
  const runCalls: Array<{ input: Message[]; requestId?: string }> = [];
  const history: Message[] = [...(options.baseline ?? [])];
  let processing = options.isProcessing ?? false;

  const target: MockTarget = {
    conversationId: options.conversationId ?? "conv-test",
    emittedEvents,
    pushedMessages,
    runCalls,
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
        // Final history = input + optional assistant message.
        const next = [...input];
        if (options.scriptedAssistant) {
          next.push(options.scriptedAssistant);
          await onEvent({
            type: "message_complete",
            message: options.scriptedAssistant,
          });
        }
        return next;
      },
    },
    getMessages: () => history,
    pushMessage: (msg: Message) => {
      pushedMessages.push(msg);
      history.push(msg);
    },
    emitToClient: (msg) => {
      emittedEvents.push(msg);
    },
    isProcessing: () => processing,
  };

  // Expose processing setter via test-only side-channel
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
    // message_complete event flushed to the client.
    const flushed = target.emittedEvents.find(
      (e) =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "message_complete",
    );
    expect(flushed).toBeDefined();
  });

  test("two concurrent wakes on the same conversation are serialized", async () => {
    // Build a target whose agentLoop.run resolves only when we signal.
    const gate1 = Promise.withResolvers<void>();
    const gate2 = Promise.withResolvers<void>();
    const runStartOrder: number[] = [];
    const runCompleteOrder: number[] = [];

    let callIndex = 0;
    const history: Message[] = [];
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
      emitToClient: () => {},
      isProcessing: () => false,
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
      emitToClient: () => {},
      isProcessing: () => processing,
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
    const target: WakeTarget = {
      conversationId: "conv-err",
      agentLoop: {
        run: async () => {
          throw new Error("LLM exploded");
        },
      },
      getMessages: () => history,
      pushMessage: () => {},
      emitToClient: () => {},
      isProcessing: () => false,
    };

    const result = await wakeAgentForOpportunity(
      { conversationId: "conv-err", hint: "boom", source: "t" },
      { resolveTarget: async () => target },
    );

    expect(result).toEqual({ invoked: true, producedToolCalls: false });
    expect(persistedMessages).toHaveLength(0);
  });
});
