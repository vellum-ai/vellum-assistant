/**
 * Wiring tests for the `chat.assistant_reply` emit in `runDeferredTurnTail`.
 *
 * Coverage matrix:
 *   - a `message_complete` turn emits exactly once, carrying the conversation
 *     id and the turn's last assistant row id;
 *   - handoff and cancellation outcomes never emit;
 *   - a completed turn that produced no assistant row never emits;
 *   - the emit runs after the deferred finalize effects, so the producer's
 *     unseen check reads the attention cursor this turn just projected;
 *   - the tail does not await the producer, and a producer failure cannot
 *     break turn finalization.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { InflightContentWriter } from "../inflight-message-content.js";

// The finalize module's import graph reaches the memory indexer; keep it inert
// so no embedding backend is touched.
setConfig("memory", { enabled: false, v2: { enabled: false } });

const CONVERSATION_ID = "conv-tail-1";
const ASSISTANT_MESSAGE_ID = "msg-assistant-1";

interface EmitCall {
  conversationId: string;
  assistantMessageId: string;
}

const emitCalls: EmitCall[] = [];
/** Ordered trace of the tail's deferred work, for the ordering assertion. */
const trace: string[] = [];
let producerBehavior: "resolve" | "reject" | "hang" = "resolve";

mock.module("../../notifications/assistant-reply-producer.js", () => ({
  emitAssistantReplyNotification: (params: EmitCall): Promise<void> => {
    emitCalls.push({
      conversationId: params.conversationId,
      assistantMessageId: params.assistantMessageId,
    });
    trace.push("emit");
    if (producerBehavior === "reject") {
      const rejected = Promise.reject(new Error("simulated producer failure"));
      // The call site fires the producer without awaiting it, so nothing in
      // the tail observes this rejection. Settle it here so the failure stays
      // a test fixture rather than a process-level unhandled rejection.
      rejected.catch(() => {});
      return rejected;
    }
    if (producerBehavior === "hang") {
      return new Promise<void>(() => {});
    }
    return Promise.resolve();
  },
}));

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  // No conversation row: the tail's truncation and disk-sync steps
  // short-circuit, keeping these tests on the notify wiring.
  getConversation: () => null,
}));

const { runDeferredTurnTail } =
  await import("../conversation-turn-finalize.js");

const rlog = makeMockLogger() as Parameters<
  typeof runDeferredTurnTail
>[0]["rlog"];

async function runTail(overrides: {
  turnCompleted: boolean;
  lastAssistantMessageId?: string | undefined;
  deferredFinalizeEffects?: ReadonlyArray<() => Promise<void>>;
}): Promise<void> {
  await runDeferredTurnTail({
    ctx: { conversationId: CONVERSATION_ID, messages: [] },
    state: {
      deferredFinalizeEffects: overrides.deferredFinalizeEffects ?? [],
      lastAssistantMessageId:
        "lastAssistantMessageId" in overrides
          ? overrides.lastAssistantMessageId
          : ASSISTANT_MESSAGE_ID,
      inflightWriters: new Map<string, InflightContentWriter>(),
    },
    rlog,
    generationCompletedAt: Date.now(),
    turnCompleted: overrides.turnCompleted,
  });
}

beforeEach(() => {
  emitCalls.length = 0;
  trace.length = 0;
  producerBehavior = "resolve";
});

describe("runDeferredTurnTail assistant-reply notification", () => {
  test("emits once for a completed turn", async () => {
    await runTail({ turnCompleted: true });

    expect(emitCalls).toEqual([
      {
        conversationId: CONVERSATION_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      },
    ]);
  });

  test("stays silent for a handed-off or cancelled turn", async () => {
    await runTail({ turnCompleted: false });

    expect(emitCalls).toEqual([]);
  });

  test("stays silent when the turn produced no assistant row", async () => {
    await runTail({ turnCompleted: true, lastAssistantMessageId: undefined });

    expect(emitCalls).toEqual([]);
  });

  test("emits after the deferred finalize effects have run", async () => {
    await runTail({
      turnCompleted: true,
      deferredFinalizeEffects: [
        async () => {
          trace.push("effect-1");
        },
        async () => {
          trace.push("effect-2");
        },
      ],
    });

    expect(trace).toEqual(["effect-1", "effect-2", "emit"]);
  });

  test("completes without awaiting the producer, even when it never settles", async () => {
    producerBehavior = "hang";

    await runTail({ turnCompleted: true });

    expect(emitCalls).toHaveLength(1);
  });

  test("survives a failing producer", async () => {
    producerBehavior = "reject";

    await runTail({ turnCompleted: true });

    expect(emitCalls).toHaveLength(1);
  });
});
