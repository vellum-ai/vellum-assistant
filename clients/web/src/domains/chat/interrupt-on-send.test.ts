/**
 * `interrupt-on-send` on the client: a message sent into a busy turn is not
 * queued, and the stream it produces (the interrupted turn's cancel, then the
 * new turn) folds into a live turn rather than an idle one.
 */
import { describe, expect, test } from "bun:test";

import { getInterruptOnSend } from "@/domains/chat/hooks/use-interrupt-on-send";
import { applyEvent } from "@/domains/chat/transcript/rolling-snapshot";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { endTurn } from "@/domains/chat/turn-coordinator";
import {
  INITIAL_TURN_STATE,
  turnReducer,
  useTurnStore,
  type TurnState,
} from "@/domains/chat/turn-store";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { shouldQueueSend } from "@/domains/chat/utils/send-message-utils";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { AssistantEvent } from "@/types/event-types";
import type {
  AssistantEventEnvelope,
  ConversationMessage,
} from "@vellumai/assistant-api";

describe("shouldQueueSend", () => {
  test("a send into a busy turn does not queue when the flag is on", () => {
    expect(shouldQueueSend("thinking", true)).toBe(false);
    expect(shouldQueueSend("streaming", true)).toBe(false);
    expect(shouldQueueSend("awaiting_user_input", true)).toBe(false);
  });

  test("a send into a busy turn queues when the flag is off", () => {
    expect(shouldQueueSend("thinking", false)).toBe(true);
    expect(shouldQueueSend("streaming", false)).toBe(true);
  });

  test("a send into an idle turn never queues either way", () => {
    expect(shouldQueueSend("idle", false)).toBe(false);
    expect(shouldQueueSend("idle", true)).toBe(false);
    expect(shouldQueueSend("errored", true)).toBe(false);
  });
});

describe("getInterruptOnSend", () => {
  test("reads the assistant flag store, defaulting to the daemon's queueing behaviour", () => {
    expect(getInterruptOnSend()).toBe(false);
    useAssistantFeatureFlagStore.getState().setFlags({ interruptOnSend: true });
    expect(getInterruptOnSend()).toBe(true);
    useAssistantFeatureFlagStore
      .getState()
      .setFlags({ interruptOnSend: false });
    expect(getInterruptOnSend()).toBe(false);
  });
});

describe("interrupt event order", () => {
  function fold(state: TurnState, events: Parameters<typeof turnReducer>[1][]) {
    return events.reduce(turnReducer, state);
  }

  test("the cancel settles the old turn and the new turn's thinking picks straight back up", () => {
    // What the daemon puts on the wire for an interrupt: the aborted turn's
    // `generation_cancelled`, then the interrupt's own thinking signal ahead
    // of the new turn.
    const afterSend = fold(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "turn-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "turn-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);
    expect(afterSend.phase).toBe("streaming");

    const afterInterrupt = fold(afterSend, [
      { type: "GENERATION_CANCELLED" },
      { type: "ACTIVITY_STATE_THINKING", canStartFromIdle: true },
    ]);

    expect(afterInterrupt.phase).toBe("thinking");
    expect(afterInterrupt.pendingQueuedCount).toBe(0);
  });

  test("the cancel goes to idle, not queued, because nothing was queued", () => {
    const afterSend = fold(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "turn-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "turn-1" },
    ]);

    const cancelled = turnReducer(afterSend, { type: "GENERATION_CANCELLED" });

    expect(cancelled.phase).toBe("idle");
    expect(cancelled.lastTerminalReason).toBe("cancelled");
  });

  test("the new turn's reply streams after the cancel", () => {
    const afterInterrupt = fold(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "turn-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "turn-1" },
      { type: "GENERATION_CANCELLED" },
      { type: "ACTIVITY_STATE_THINKING", canStartFromIdle: true },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);

    expect(afterInterrupt.phase).toBe("streaming");
  });

  test("a second interrupt inside the new turn folds the same way", () => {
    const afterSecond = fold(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "turn-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "turn-1" },
      { type: "GENERATION_CANCELLED" },
      { type: "ACTIVITY_STATE_THINKING", canStartFromIdle: true },
      { type: "GENERATION_CANCELLED" },
      { type: "ACTIVITY_STATE_THINKING", canStartFromIdle: true },
    ]);

    expect(afterSecond.phase).toBe("thinking");
    expect(afterSecond.pendingQueuedCount).toBe(0);
  });
});

describe("history after an interrupt", () => {
  function runtimeMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
  ): ConversationMessage {
    return {
      id,
      role,
      textSegments: [text],
      timestamp: new Date(1_700_000_000_000).toISOString(),
    } as ConversationMessage;
  }

  test("a refetch keeps the interrupted reply, the new user row, and the new reply in order", () => {
    // The daemon writes the interrupting user row only after the interrupted
    // turn has settled, so a fetch that lands afterwards reads assistant,
    // user, assistant: the transcript order the user watched happen.
    const fetched: ConversationMessage[] = [
      runtimeMessage("m1", "user", "start the long job"),
      runtimeMessage("m2", "assistant", "working on it"),
      runtimeMessage("m3", "user", "actually, stop and tell me the time"),
      runtimeMessage("m4", "assistant", "it is nine o'clock"),
    ];

    const mapped = fetched.map(mapRuntimeToDisplayMessage);

    expect(mapped.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(mapped.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // No row carries a queue badge: nothing on this path was ever queued.
    expect(mapped.some((m) => m.queueStatus !== undefined)).toBe(false);
  });
});

describe("the replacement turn on the wire", () => {
  const CONV = "conv-interrupt";

  function env(seq: number, message: AssistantEvent): AssistantEventEnvelope {
    return {
      id: `e${seq}`,
      seq,
      emittedAt: new Date(1000 + seq).toISOString(),
      message,
    } as AssistantEventEnvelope;
  }

  /** Turn A mid-tool: its assistant row is open and its tool has not answered. */
  function interruptedHistory(): PaginatedHistoryResult {
    return {
      messages: [
        {
          id: "u1",
          role: "user",
          textSegments: ["run the long job"],
          contentOrder: [{ type: "text", id: "0" }],
        },
        {
          id: "msg-a",
          role: "assistant",
          textSegments: ["on it"],
          contentOrder: [{ type: "text", id: "0" }],
        },
      ],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      seq: 10,
    } as unknown as PaginatedHistoryResult;
  }

  /**
   * What the daemon puts on the wire for an interrupt, in the order the live
   * QA log shows: the aborted turn's cancel, the armed `message_interrupted`
   * signal, the interrupting user row, then the replacement turn.
   */
  const WIRE: AssistantEventEnvelope[] = [
    env(11, {
      type: "generation_cancelled",
      conversationId: CONV,
    } as AssistantEvent),
    env(12, {
      type: "assistant_activity_state",
      conversationId: CONV,
      phase: "thinking",
      reason: "message_interrupted",
      activityVersion: 5,
    } as AssistantEvent),
    env(13, {
      type: "user_message_echo",
      conversationId: CONV,
      messageId: "u2",
      text: "What is 17 times 23?",
    } as AssistantEvent),
    env(14, {
      type: "assistant_turn_start",
      conversationId: CONV,
      messageId: "msg-b",
    } as AssistantEvent),
    env(15, {
      type: "assistant_text_delta",
      conversationId: CONV,
      messageId: "msg-b",
      text: "391.",
    } as AssistantEvent),
    env(16, {
      type: "message_complete",
      conversationId: CONV,
      messageId: "msg-b",
    } as AssistantEvent),
  ];

  test("the reply renders under its own row and the composer returns to idle", () => {
    const history = WIRE.reduce(applyEvent, interruptedHistory());

    // The interrupted reply, the interrupting user row, and the new reply, in
    // the order they happened. The new reply opens its own row rather than
    // folding into the row the stopped turn left behind.
    expect(history.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history.messages.map((m) => m.id)).toEqual([
      "u1",
      "msg-a",
      "u2",
      "msg-b",
    ]);
    expect(history.messages[3]?.textSegments).toEqual(["391."]);

    const turn = [
      { type: "USER_SEND_REQUESTED" as const, turnId: "turn-a" },
      { type: "USER_SEND_ACCEPTED" as const, turnId: "turn-a" },
      { type: "ASSISTANT_TEXT_DELTA" as const },
      { type: "TOOL_USE_START" as const },
      // The send is answered before the abort, so this client claims the
      // replacement turn first and the cancel for turn A lands behind it.
      {
        type: "USER_SEND_REQUESTED" as const,
        turnId: "turn-b",
        interruptsRunningTurn: true,
      },
      { type: "USER_SEND_ACCEPTED" as const, turnId: "turn-b" },
      { type: "GENERATION_CANCELLED" as const },
      { type: "ACTIVITY_STATE_THINKING" as const, canStartFromIdle: true },
      { type: "ASSISTANT_TEXT_DELTA" as const },
      { type: "MESSAGE_COMPLETE" as const },
    ].reduce(turnReducer, INITIAL_TURN_STATE);

    expect(turn.phase).toBe("idle");
    expect(turn.lastTerminalReason).toBe("complete");
  });

  test("the replacement turn keeps its identity, so the stall rescue can reach it", () => {
    // The cancel of the turn this send replaced is a handoff, not this turn's
    // terminal. Idling on it dropped `activeTurnId`, and both backstops that
    // recover a turn whose terminal event never arrived (the poll rescue and
    // the turn timeout) refuse to act on a turn they cannot name: the composer
    // stayed busy with nothing left to settle it.
    const mid = [
      { type: "USER_SEND_REQUESTED" as const, turnId: "turn-a" },
      { type: "USER_SEND_ACCEPTED" as const, turnId: "turn-a" },
      { type: "ASSISTANT_TEXT_DELTA" as const },
      {
        type: "USER_SEND_REQUESTED" as const,
        turnId: "turn-b",
        interruptsRunningTurn: true,
      },
      { type: "USER_SEND_ACCEPTED" as const, turnId: "turn-b" },
      { type: "GENERATION_CANCELLED" as const },
    ].reduce(turnReducer, INITIAL_TURN_STATE);

    expect(mid.phase).toBe("thinking");
    expect(mid.activeTurnId).toBe("turn-b");
    // Consumed by the cancel it explains, so a later Stop on this turn is
    // terminal in the ordinary way.
    expect(mid.interruptingTurnId).toBeNull();

    // The rescue the daemon's missing terminal would otherwise strand.
    useTurnStore.setState(mid);
    endTurn({
      conversationId: CONV,
      reason: "rescued",
      rescuedTurnId: "turn-b",
    });
    expect(useTurnStore.getState().phase).toBe("idle");
  });

  test("a Stop with no send behind it is still terminal", () => {
    const stopped = [
      { type: "USER_SEND_REQUESTED" as const, turnId: "turn-a" },
      { type: "USER_SEND_ACCEPTED" as const, turnId: "turn-a" },
      { type: "ASSISTANT_TEXT_DELTA" as const },
      { type: "GENERATION_CANCELLED" as const },
    ].reduce(turnReducer, INITIAL_TURN_STATE);

    expect(stopped.phase).toBe("idle");
    expect(stopped.activeTurnId).toBeNull();
    expect(stopped.lastTerminalReason).toBe("cancelled");
  });

  test("a passive viewer's cancel is terminal, since it started no send", () => {
    // The same `generation_cancelled` reaches every client. Only the one whose
    // send caused it holds the marker, so a viewer idles exactly as before.
    const viewer = [
      { type: "ACTIVITY_STATE_THINKING" as const, canStartFromIdle: true },
      { type: "ASSISTANT_TEXT_DELTA" as const },
      { type: "GENERATION_CANCELLED" as const },
    ].reduce(turnReducer, INITIAL_TURN_STATE);

    expect(viewer.phase).toBe("idle");
    expect(viewer.lastTerminalReason).toBe("cancelled");
  });
});
