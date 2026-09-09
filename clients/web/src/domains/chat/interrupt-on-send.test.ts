/**
 * `interrupt-on-send` on the client: a message sent into a busy turn is not
 * queued, and the stream it produces (the interrupted turn's cancel, then the
 * new turn) folds into a live turn rather than an idle one.
 */
import { describe, expect, test } from "bun:test";

import { getInterruptOnSend } from "@/domains/chat/hooks/use-interrupt-on-send";
import {
  INITIAL_TURN_STATE,
  turnReducer,
  type TurnState,
} from "@/domains/chat/turn-store";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { shouldQueueSend } from "@/domains/chat/utils/send-message-utils";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { ConversationMessage } from "@vellumai/assistant-api";

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
    useAssistantFeatureFlagStore
      .getState()
      .setFlags({ interruptOnSend: true });
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
