import { describe, expect, test } from "bun:test";

import {
  shouldShowThinkingIndicator,
  isAssistantBusy,
  isSendDisabled,
  type UIContext,
} from "@/domains/chat/turn-selectors";
import {
  type TurnState,
  type DomainEvent,
  INITIAL_TURN_STATE,
  turnReducer,
  isSending,
  isThinking,
} from "@/domains/chat/turn-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a sequence of events to a state, returning the final state. */
function applyEvents(state: TurnState, events: DomainEvent[]): TurnState {
  return events.reduce(turnReducer, state);
}

const defaultCtx: UIContext = {
  hasStreamingAssistantMessage: false,
  hasStreamingAssistantThinking: false,
  hasPendingSecret: false,
  hasPendingConfirmation: false,
  hasPendingQuestion: false,
  hasPendingContactRequest: false,
  hasUncompletedVisibleSurface: false,
};

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("INITIAL_TURN_STATE", () => {
  test("starts idle with no active turn", () => {
    expect(INITIAL_TURN_STATE.phase).toBe("idle");
    expect(INITIAL_TURN_STATE.pendingQueuedCount).toBe(0);
    expect(INITIAL_TURN_STATE.activeToolCallCount).toBe(0);
    expect(INITIAL_TURN_STATE.activeTurnId).toBeNull();
    expect(INITIAL_TURN_STATE.lastTerminalReason).toBeNull();
    expect(INITIAL_TURN_STATE.statusText).toBeNull();
    expect(INITIAL_TURN_STATE.liveWebActivity).toEqual({});
  });

  test("isSending is false in initial state", () => {
    expect(isSending(INITIAL_TURN_STATE.phase)).toBe(false);
  });

  test("isThinking is false in initial state", () => {
    expect(isThinking(INITIAL_TURN_STATE.phase)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// USER_SEND_REQUESTED
// ---------------------------------------------------------------------------

describe("USER_SEND_REQUESTED", () => {
  test("transitions from idle to thinking", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "turn-1",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("turn-1");
    expect(isSending(state.phase)).toBe(true);
    expect(isThinking(state.phase)).toBe(true);
  });

  test("clears lastTerminalReason", () => {
    const errored: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "idle",
      lastTerminalReason: "error",
    };
    const state = turnReducer(errored, {
      type: "USER_SEND_REQUESTED",
      turnId: "turn-2",
    });
    expect(state.lastTerminalReason).toBeNull();
  });

  test("resets activeToolCallCount", () => {
    const withTools: TurnState = {
      ...INITIAL_TURN_STATE,
      activeToolCallCount: 3,
    };
    const state = turnReducer(withTools, {
      type: "USER_SEND_REQUESTED",
    });
    expect(state.activeToolCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// USER_SEND_ACCEPTED
// ---------------------------------------------------------------------------

describe("USER_SEND_ACCEPTED", () => {
  test("sets turnId without changing phase when already thinking", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "temp",
    });
    const state = turnReducer(thinking, {
      type: "USER_SEND_ACCEPTED",
      turnId: "real-turn-id",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("real-turn-id");
  });

  test("restores thinking phase when a stale terminal landed between request and accept", () => {
    // Wild repro:
    //   USER_SEND_REQUESTED(turn-NEW)
    //     → phase=thinking, activeTurnId=turn-NEW, lastTerminalReason=null
    //   ← stale MESSAGE_COMPLETE from a previous turn arrives during
    //     the POST await
    //     → phase=idle, activeTurnId=null, lastTerminalReason=complete
    //   USER_SEND_ACCEPTED(turn-NEW)
    //     → must restore the in-flight shape (phase=thinking,
    //       lastTerminalReason=null) so the thinking indicator stays
    //       visible until the first assistant delta arrives.
    const clobbered: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "idle",
      activeTurnId: null,
      lastTerminalReason: "complete",
    };
    const state = turnReducer(clobbered, {
      type: "USER_SEND_ACCEPTED",
      turnId: "turn-NEW",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("turn-NEW");
    expect(state.lastTerminalReason).toBeNull();
    expect(isSending(state.phase)).toBe(true);
    expect(isThinking(state.phase)).toBe(true);
  });

  test("restores thinking phase from errored as well", () => {
    const erroredState: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
      activeTurnId: null,
      lastTerminalReason: "error",
    };
    const state = turnReducer(erroredState, {
      type: "USER_SEND_ACCEPTED",
      turnId: "turn-NEW",
    });
    expect(state.phase).toBe("thinking");
    expect(state.lastTerminalReason).toBeNull();
  });

  test("leaves non-terminal phases alone (e.g. awaiting_user_input from a surface)", () => {
    // If the user already replied to a prompt that put us in awaiting_user_input
    // and the next send is being accepted, do not regress the phase to "thinking".
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeTurnId: "turn-OLD",
    };
    const state = turnReducer(awaiting, {
      type: "USER_SEND_ACCEPTED",
      turnId: "turn-NEW",
    });
    expect(state.phase).toBe("awaiting_user_input");
    expect(state.activeTurnId).toBe("turn-NEW");
  });
});

// ---------------------------------------------------------------------------
// ASSISTANT_TEXT_DELTA
// ---------------------------------------------------------------------------

describe("ASSISTANT_TEXT_DELTA", () => {
  test("transitions thinking to streaming", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    const state = turnReducer(thinking, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
    expect(isSending(state.phase)).toBe(true);
    expect(isThinking(state.phase)).toBe(false);
  });

  test("does NOT re-activate from idle when activeTurnId is null", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "ASSISTANT_TEXT_DELTA",
    });
    expect(state.phase).toBe("idle");
  });

  test("re-activates from idle when activeTurnId is set", () => {
    const idleWithTurn: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "idle",
      activeTurnId: "t-active",
    };
    const state = turnReducer(idleWithTurn, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
  });

  test("does NOT re-activate from errored when activeTurnId is null", () => {
    const errored: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
    };
    const state = turnReducer(errored, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("errored");
  });

  test("re-activates from errored when activeTurnId is set", () => {
    const errored: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
      activeTurnId: "t-active",
    };
    const state = turnReducer(errored, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
  });

  test("stays streaming when already streaming", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
    };
    const state = turnReducer(streaming, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
    expect(state.activeTurnId).toBe("t-1");
  });
});

// ---------------------------------------------------------------------------
// TOOL_USE_START / TOOL_RESULT
// ---------------------------------------------------------------------------

describe("tool call tracking", () => {
  test("TOOL_USE_START increments count when turn is active", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-tool",
    });
    const state = turnReducer(thinking, { type: "TOOL_USE_START" });
    expect(state.activeToolCallCount).toBe(1);

    const state2 = turnReducer(state, { type: "TOOL_USE_START" });
    expect(state2.activeToolCallCount).toBe(2);
  });

  test("TOOL_USE_START is fully discarded when idle with null activeTurnId", () => {
    const state = turnReducer(INITIAL_TURN_STATE, { type: "TOOL_USE_START" });
    expect(state.activeToolCallCount).toBe(0);
    expect(state.phase).toBe("idle");
  });

  test("TOOL_RESULT decrements count", () => {
    const withTools: TurnState = {
      ...INITIAL_TURN_STATE,
      activeToolCallCount: 2,
    };
    const state = turnReducer(withTools, { type: "TOOL_RESULT" });
    expect(state.activeToolCallCount).toBe(1);
  });

  test("TOOL_RESULT does not go below zero", () => {
    const state = turnReducer(INITIAL_TURN_STATE, { type: "TOOL_RESULT" });
    expect(state.activeToolCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TOOL_ACTIVITY_METADATA
// ---------------------------------------------------------------------------

describe("TOOL_ACTIVITY_METADATA", () => {
  const sampleMetadata = {
    webSearch: {
      query: "tigers",
      provider: "anthropic-native" as const,
      resultCount: 1,
      durationMs: 100,
      results: [
        {
          rank: 1,
          title: "Tigers",
          url: "https://example.com/tigers",
          domain: "example.com",
        },
      ],
    },
  };

  test("populates liveWebActivity keyed by toolUseId during an active turn", () => {
    const active = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "TOOL_USE_START" },
    ]);
    const state = turnReducer(active, {
      type: "TOOL_ACTIVITY_METADATA",
      toolUseId: "tc-1",
      metadata: sampleMetadata,
    });
    expect(state.liveWebActivity["tc-1"]).toEqual(sampleMetadata);
  });

  test("is discarded when state is stale (idle with no activeTurnId)", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "TOOL_ACTIVITY_METADATA",
      toolUseId: "tc-1",
      metadata: sampleMetadata,
    });
    expect(state.liveWebActivity).toEqual({});
  });

  test("MESSAGE_COMPLETE clears liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, { type: "MESSAGE_COMPLETE" });
    expect(state.liveWebActivity).toEqual({});
  });

  test("STREAM_ERROR clears liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, { type: "STREAM_ERROR" });
    expect(state.liveWebActivity).toEqual({});
  });

  test("GENERATION_CANCELLED clears liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, { type: "GENERATION_CANCELLED" });
    expect(state.liveWebActivity).toEqual({});
  });

  test("TURN_TIMEOUT clears liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, { type: "TURN_TIMEOUT" });
    expect(state.liveWebActivity).toEqual({});
  });

  test("POLL_RECONCILED clears liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, {
      type: "POLL_RECONCILED",
      turnId: "t-1",
    });
    expect(state.liveWebActivity).toEqual({});
  });

  test("GENERATION_HANDOFF does NOT clear liveWebActivity", () => {
    const withActivity: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
      liveWebActivity: { "tc-1": sampleMetadata },
    };
    const state = turnReducer(withActivity, { type: "GENERATION_HANDOFF" });
    expect(state.liveWebActivity).toEqual({ "tc-1": sampleMetadata });
  });
});

// ---------------------------------------------------------------------------
// ACTIVITY_STATE_THINKING
// ---------------------------------------------------------------------------

describe("ACTIVITY_STATE_THINKING", () => {
  test("transitions streaming back to thinking when turn is active", () => {
    const streaming = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);
    expect(streaming.phase).toBe("streaming");
    const state = turnReducer(streaming, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("t-1");
  });

  test("transitions streaming → thinking after tool call completes", () => {
    const afterTool = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "TOOL_USE_START" },
      { type: "TOOL_RESULT" },
    ]);
    expect(afterTool.phase).toBe("streaming");
    expect(afterTool.activeToolCallCount).toBe(0);
    const state = turnReducer(afterTool, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.phase).toBe("thinking");
  });

  test("is discarded when idle with null activeTurnId", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "ACTIVITY_STATE_THINKING",
    });
    expect(state.phase).toBe("idle");
    expect(state).toBe(INITIAL_TURN_STATE);
  });

  test("is discarded when errored with null activeTurnId", () => {
    const errored: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
    };
    const state = turnReducer(errored, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.phase).toBe("errored");
    expect(state).toBe(errored);
  });

  test("does not affect activeToolCallCount", () => {
    const withTool = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "TOOL_USE_START" },
    ]);
    expect(withTool.activeToolCallCount).toBe(1);
    const state = turnReducer(withTool, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.activeToolCallCount).toBe(1);
    expect(state.phase).toBe("thinking");
  });

  test("is discarded when awaiting_user_input", () => {
    const awaiting = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "CONFIRMATION_REQUEST" },
    ]);
    expect(awaiting.phase).toBe("awaiting_user_input");
    const state = turnReducer(awaiting, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.phase).toBe("awaiting_user_input");
    expect(state).toBe(awaiting);
  });

  test("stores statusText from event payload", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-1",
    });
    const state = turnReducer(thinking, {
      type: "ACTIVITY_STATE_THINKING",
      statusText: "Processing bash results",
    });
    expect(state.statusText).toBe("Processing bash results");
  });

  test("sets statusText to null when event has no statusText", () => {
    const withStatus = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING", statusText: "Compacting context" },
    ]);
    expect(withStatus.statusText).toBe("Compacting context");
    const state = turnReducer(withStatus, { type: "ACTIVITY_STATE_THINKING" });
    expect(state.statusText).toBeNull();
  });

  test("statusText is cleared on MESSAGE_COMPLETE", () => {
    const withStatus = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING", statusText: "Processing" },
    ]);
    const state = turnReducer(withStatus, { type: "MESSAGE_COMPLETE" });
    expect(state.statusText).toBeNull();
  });

  test("statusText is cleared on GENERATION_CANCELLED", () => {
    const withStatus = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING", statusText: "Processing" },
    ]);
    const state = turnReducer(withStatus, { type: "GENERATION_CANCELLED" });
    expect(state.statusText).toBeNull();
  });

  test("statusText is cleared on USER_SEND_REQUESTED (new turn)", () => {
    const withStatus = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING", statusText: "Processing" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    const state = turnReducer(withStatus, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-2",
    });
    expect(state.statusText).toBeNull();
  });

  test("statusText is cleared on GENERATION_HANDOFF", () => {
    const withStatus = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING", statusText: "Processing" },
    ]);
    const state = turnReducer(withStatus, { type: "GENERATION_HANDOFF" });
    expect(state.statusText).toBeNull();
    expect(state.phase).toBe("thinking");
  });

  test("statusText updates when a new thinking event arrives", () => {
    const first = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      {
        type: "ACTIVITY_STATE_THINKING",
        statusText: "Processing bash results",
      },
    ]);
    expect(first.statusText).toBe("Processing bash results");
    const second = turnReducer(first, {
      type: "ACTIVITY_STATE_THINKING",
      statusText: "Resuming after approval",
    });
    expect(second.statusText).toBe("Resuming after approval");
  });
});

// ---------------------------------------------------------------------------
// UI_SURFACE_* events
// ---------------------------------------------------------------------------

describe("UI surface events", () => {
  test("UI_SURFACE_SHOW with interactive=true transitions to awaiting_user_input", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    const state = turnReducer(thinking, {
      type: "UI_SURFACE_SHOW",
      interactive: true,
    });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("UI_SURFACE_SHOW with interactive=false does not change phase", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    const state = turnReducer(thinking, {
      type: "UI_SURFACE_SHOW",
      interactive: false,
    });
    expect(state.phase).toBe("thinking");
  });

  test("UI_SURFACE_UPDATE does not change phase", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
    };
    const state = turnReducer(awaiting, { type: "UI_SURFACE_UPDATE" });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("UI_SURFACE_DISMISS transitions awaiting_user_input to thinking when no active tool calls", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
    };
    const state = turnReducer(awaiting, { type: "UI_SURFACE_DISMISS" });
    expect(state.phase).toBe("thinking");
  });

  test("UI_SURFACE_DISMISS preserves awaiting_user_input when tool calls are active", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeToolCallCount: 1,
    };
    const state = turnReducer(awaiting, { type: "UI_SURFACE_DISMISS" });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("UI_SURFACE_DISMISS preserves phase when not awaiting_user_input", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
    };
    const state = turnReducer(streaming, { type: "UI_SURFACE_DISMISS" });
    expect(state.phase).toBe("streaming");
  });

  test("UI_SURFACE_COMPLETE transitions awaiting_user_input to thinking when no active tool calls", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeToolCallCount: 0,
    };
    const state = turnReducer(awaiting, { type: "UI_SURFACE_COMPLETE" });
    expect(state.phase).toBe("thinking");
  });

  test("UI_SURFACE_COMPLETE preserves awaiting_user_input when tool calls are active", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeToolCallCount: 1,
    };
    const state = turnReducer(awaiting, { type: "UI_SURFACE_COMPLETE" });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("UI_SURFACE_COMPLETE preserves non-awaiting phases", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
    };
    const state = turnReducer(streaming, { type: "UI_SURFACE_COMPLETE" });
    expect(state.phase).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// SECRET_REQUEST / CONFIRMATION_REQUEST
// ---------------------------------------------------------------------------

describe("interruption events", () => {
  test("SECRET_REQUEST transitions to awaiting_user_input", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
    };
    const state = turnReducer(streaming, { type: "SECRET_REQUEST" });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("CONFIRMATION_REQUEST transitions to awaiting_user_input", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    const state = turnReducer(thinking, { type: "CONFIRMATION_REQUEST" });
    expect(state.phase).toBe("awaiting_user_input");
  });

  test("QUESTION_REQUEST during streaming transitions to awaiting_user_input", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "t-1",
    };
    const state = turnReducer(streaming, { type: "QUESTION_REQUEST" });
    expect(state.phase).toBe("awaiting_user_input");
    expect(state.activeTurnId).toBe("t-1");
    expect(isSending(state.phase)).toBe(true);
  });

  test("QUESTION_REQUEST when idle with null activeTurnId is a no-op", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "QUESTION_REQUEST",
    });
    expect(state).toEqual(INITIAL_TURN_STATE);
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MESSAGE_COMPLETE
// ---------------------------------------------------------------------------

describe("MESSAGE_COMPLETE", () => {
  test("transitions to idle and clears turn", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "turn-1",
      activeToolCallCount: 1,
    };
    const state = turnReducer(streaming, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.activeToolCallCount).toBe(0);
    expect(state.lastTerminalReason).toBe("complete");
    expect(isSending(state.phase)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GENERATION_HANDOFF
// ---------------------------------------------------------------------------

describe("GENERATION_HANDOFF", () => {
  test("re-enters thinking and clears tool count", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "turn-1",
      activeToolCallCount: 2,
    };
    const state = turnReducer(streaming, { type: "GENERATION_HANDOFF" });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.activeToolCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------

describe("terminal events", () => {
  const activeState: TurnState = {
    ...INITIAL_TURN_STATE,
    phase: "streaming",
    activeTurnId: "turn-1",
    activeToolCallCount: 1,
  };

  test("GENERATION_CANCELLED returns to idle", () => {
    const state = turnReducer(activeState, { type: "GENERATION_CANCELLED" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.activeToolCallCount).toBe(0);
    expect(state.lastTerminalReason).toBe("cancelled");
  });

  test("STREAM_ERROR returns to idle with error reason", () => {
    const state = turnReducer(activeState, { type: "STREAM_ERROR" });
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("error");
  });

  test("SESSION_ERROR returns to idle with session_error reason", () => {
    const state = turnReducer(activeState, { type: "SESSION_ERROR" });
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("session_error");
  });

  test("TURN_TIMEOUT returns to idle with timeout reason", () => {
    const state = turnReducer(activeState, { type: "TURN_TIMEOUT" });
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// POLL_RECONCILED
// ---------------------------------------------------------------------------

describe("POLL_RECONCILED", () => {
  test("forces idle when in active phase", () => {
    const thinking: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: "turn-1",
    };
    const state = turnReducer(thinking, { type: "POLL_RECONCILED" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("is a no-op when already idle", () => {
    const state = turnReducer(INITIAL_TURN_STATE, {
      type: "POLL_RECONCILED",
    });
    expect(state).toEqual(INITIAL_TURN_STATE);
  });

  test("forces idle from streaming phase", () => {
    const streaming: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "streaming",
      activeTurnId: "turn-1",
      activeToolCallCount: 2,
    };
    const state = turnReducer(streaming, { type: "POLL_RECONCILED" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.activeToolCallCount).toBe(0);
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("forces idle from awaiting_user_input phase", () => {
    const awaiting: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "awaiting_user_input",
      activeTurnId: "turn-1",
    };
    const state = turnReducer(awaiting, { type: "POLL_RECONCILED" });
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("with matching turnId transitions to idle", () => {
    const thinking: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: "turn-1",
    };
    const state = turnReducer(thinking, {
      type: "POLL_RECONCILED",
      turnId: "turn-1",
    });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("with mismatched turnId is a no-op (stale poll)", () => {
    const thinking: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: "turn-2",
    };
    const state = turnReducer(thinking, {
      type: "POLL_RECONCILED",
      turnId: "turn-1",
    });
    // Should not transition because turnId does not match
    expect(state).toEqual(thinking);
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("turn-2");
  });

  test("with turnId but no activeTurnId is a no-op (turn already cleared)", () => {
    const idle: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "idle",
      activeTurnId: null,
      lastTerminalReason: "complete",
    };
    const state = turnReducer(idle, {
      type: "POLL_RECONCILED",
      turnId: "turn-1",
    });
    expect(state).toEqual(idle);
  });

  test("without turnId falls back to phase-based check (legacy behavior)", () => {
    const thinking: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: "turn-1",
    };
    const state = turnReducer(thinking, { type: "POLL_RECONCILED" });
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("is a no-op when errored phase (not an active sending phase)", () => {
    const errored: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
      lastTerminalReason: "error",
    };
    const state = turnReducer(errored, { type: "POLL_RECONCILED" });
    expect(state).toEqual(errored);
  });
});

// ---------------------------------------------------------------------------
// Polling / SSE race conditions
// ---------------------------------------------------------------------------

describe("polling / SSE race conditions", () => {
  test("SSE completes before poll — poll for same turnId is no-op", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-1",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    const afterPoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-1",
    });
    expect(afterPoll).toEqual(state);
  });

  test("poll completes before SSE — SSE message_complete is idempotent", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-2",
    });
    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-2",
    });
    expect(state.phase).toBe("idle");

    const afterSSE = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(afterSSE.phase).toBe("idle");
    expect(afterSSE.lastTerminalReason).toBe("complete");
  });

  test("TOOL_USE_START re-activates idle when activeTurnId is set", () => {
    const forcedIdle: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "idle",
      activeTurnId: "t-guard-4",
    };
    const afterTool = turnReducer(forcedIdle, { type: "TOOL_USE_START" });
    expect(afterTool.phase).toBe("thinking");
    expect(afterTool.activeToolCallCount).toBe(1);
  });

  test("POLL_RECONCILED → stale delta → new send works end-to-end", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-bg",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");

    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-bg",
    });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("idle");

    state = turnReducer(state, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-new",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("t-race-new");
  });
});

// ---------------------------------------------------------------------------
// TURN_RESET
// ---------------------------------------------------------------------------

describe("TURN_RESET", () => {
  test("returns to initial state", () => {
    const dirty: TurnState = {
      phase: "streaming",
      pendingQueuedCount: 5,
      activeToolCallCount: 3,
      activeTurnId: "turn-99",
      lastTerminalReason: "error",
      statusText: null,
      liveWebActivity: {},
    };
    const state = turnReducer(dirty, { type: "TURN_RESET" });
    expect(state).toEqual(INITIAL_TURN_STATE);
  });
});

// ---------------------------------------------------------------------------
// STALE_TURN_CLEARED
// ---------------------------------------------------------------------------

describe("STALE_TURN_CLEARED", () => {
  test("no-ops while a turn is genuinely in flight", () => {
    const inFlight: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: "turn-1",
    };
    const state = turnReducer(inFlight, { type: "STALE_TURN_CLEARED" });
    expect(state).toBe(inFlight);
  });

  test("resets stale terminal state", () => {
    const stale: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "errored",
      lastTerminalReason: "error",
      statusText: "stuck",
    };
    const state = turnReducer(stale, { type: "STALE_TURN_CLEARED" });
    expect(state).toEqual(INITIAL_TURN_STATE);
  });

  test("resets a sending phase with no active turn (stuck thinking)", () => {
    const stuck: TurnState = {
      ...INITIAL_TURN_STATE,
      phase: "thinking",
      activeTurnId: null,
    };
    const state = turnReducer(stuck, { type: "STALE_TURN_CLEARED" });
    expect(state).toEqual(INITIAL_TURN_STATE);
  });

  test("first-send reachability race: probe ready mid-send must not kill the turn", () => {
    // Regression: a new conversation's first send triggers the initial
    // reachability probe; its "ready" resolution used to hard-reset the
    // turn, nulling activeTurnId — after which ASSISTANT_TEXT_DELTA's
    // stale-delta guard refused to re-activate, so the whole first turn
    // rendered as phase "idle" (no thinking indicator, no streaming
    // affordances like the text reveal sweep).
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "t-1" },
      { type: "STALE_TURN_CLEARED" },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);
    expect(state.phase).toBe("streaming");
    expect(state.activeTurnId).toBe("t-1");
  });
});

// ---------------------------------------------------------------------------
// Complex multi-event sequences
// ---------------------------------------------------------------------------

describe("multi-event sequences", () => {
  test("normal send -> stream -> complete flow", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "USER_SEND_ACCEPTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
    expect(isSending(state.phase)).toBe(false);
  });

  test("send -> tool use -> tool result -> stream -> complete", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "TOOL_USE_START" },
      { type: "TOOL_USE_START" },
      { type: "TOOL_RESULT" },
      { type: "TOOL_RESULT" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.activeToolCallCount).toBe(0);
  });

  test("multi-message handoff flow", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "GENERATION_HANDOFF" },
      // Now re-enter thinking for next chunk
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("secret request interruption and resumption", () => {
    let state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "SECRET_REQUEST" },
    ]);
    expect(state.phase).toBe("awaiting_user_input");
    expect(isSending(state.phase)).toBe(true);

    // After secret submission, assistant resumes with text
    state = applyEvents(state, [
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
  });

  test("confirmation request interruption and resumption", () => {
    let state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "CONFIRMATION_REQUEST" },
    ]);
    expect(state.phase).toBe("awaiting_user_input");

    state = applyEvents(state, [
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
  });

  test("surface show then complete flow", () => {
    let state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "UI_SURFACE_SHOW", interactive: true },
    ]);
    expect(state.phase).toBe("awaiting_user_input");

    state = applyEvents(state, [
      { type: "UI_SURFACE_COMPLETE" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
  });

  test("surface-only interaction: complete exits awaiting and enables input after MESSAGE_COMPLETE", () => {
    // Surface shows, user interacts, surface completes — no streaming text
    let state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "UI_SURFACE_SHOW", interactive: true },
    ]);
    expect(state.phase).toBe("awaiting_user_input");
    expect(isSending(state.phase)).toBe(true);

    // Surface completes — should exit awaiting_user_input
    state = turnReducer(state, { type: "UI_SURFACE_COMPLETE" });
    expect(state.phase).toBe("thinking");
    expect(isSending(state.phase)).toBe(true);

    // MESSAGE_COMPLETE arrives — turn is done
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(isSending(state.phase)).toBe(false);
  });

  test("surface-only interaction: input is re-enabled after surface complete + MESSAGE_COMPLETE", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "UI_SURFACE_SHOW", interactive: true },
      { type: "UI_SURFACE_COMPLETE" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
    expect(isSendDisabled(defaultCtx)).toBe(false);
  });

  test("stream error mid-stream", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "STREAM_ERROR" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("error");
    expect(isSending(state.phase)).toBe(false);
  });

  test("poll reconciled as fallback for missed terminal SSE", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      // Imagine MESSAGE_COMPLETE was never received
      { type: "POLL_RECONCILED" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("double MESSAGE_COMPLETE is idempotent", () => {
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("POLL_RECONCILED after MESSAGE_COMPLETE is no-op", () => {
    const afterComplete = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    const afterPoll = turnReducer(afterComplete, {
      type: "POLL_RECONCILED",
    });
    expect(afterPoll).toEqual(afterComplete);
  });

  test("POLL_RECONCILED with turnId after SSE MESSAGE_COMPLETE is no-op (double finalization)", () => {
    // SSE completes the turn first
    const afterSSE = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(afterSSE.phase).toBe("idle");
    expect(afterSSE.activeTurnId).toBeNull();

    // Poll arrives later for the same turn — should be a no-op
    const afterPoll = turnReducer(afterSSE, {
      type: "POLL_RECONCILED",
      turnId: "t-1",
    });
    expect(afterPoll).toEqual(afterSSE);
  });

  test("MESSAGE_COMPLETE after POLL_RECONCILED is idempotent", () => {
    // Poll completes the turn first
    const afterPoll = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "POLL_RECONCILED", turnId: "t-1" },
    ]);
    expect(afterPoll.phase).toBe("idle");
    expect(afterPoll.lastTerminalReason).toBe("complete");

    // SSE MESSAGE_COMPLETE arrives later — already idle, should remain so
    const afterSSE = turnReducer(afterPoll, { type: "MESSAGE_COMPLETE" });
    expect(afterSSE.phase).toBe("idle");
    expect(afterSSE.lastTerminalReason).toBe("complete");
  });

  test("POLL_RECONCILED for stale turn does not affect new turn", () => {
    // Start turn 1, complete it, start turn 2
    const state = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "MESSAGE_COMPLETE" },
      { type: "USER_SEND_REQUESTED", turnId: "t-2" },
    ]);
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("t-2");

    // Late poll for turn 1 arrives — should NOT affect turn 2
    const afterStalePoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-1",
    });
    expect(afterStalePoll.phase).toBe("thinking");
    expect(afterStalePoll.activeTurnId).toBe("t-2");
  });

  test("poll completes turn that SSE missed entirely (thinking -> idle)", () => {
    // User sends, enters thinking, no SSE events arrive
    const thinking = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
    ]);
    expect(thinking.phase).toBe("thinking");

    // Poll detects completion
    const afterPoll = turnReducer(thinking, {
      type: "POLL_RECONCILED",
      turnId: "t-1",
    });
    expect(afterPoll.phase).toBe("idle");
    expect(afterPoll.activeTurnId).toBeNull();
    expect(afterPoll.lastTerminalReason).toBe("complete");
  });

  test("new send after error clears terminal reason", () => {
    const afterError = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "STREAM_ERROR" },
    ]);
    expect(afterError.lastTerminalReason).toBe("error");

    const state = turnReducer(afterError, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-2",
    });
    expect(state.lastTerminalReason).toBeNull();
    expect(state.phase).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

describe("shouldShowThinkingIndicator", () => {
  test("shows when thinking with no competing UI", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    expect(
      shouldShowThinkingIndicator(
        thinking.phase,
        thinking.activeToolCallCount,
        defaultCtx,
      ),
    ).toBe(true);
  });

  test("fallback: visible in streaming phase when no streaming message exists yet", () => {
    // ASSISTANT_TEXT_DELTA moves phase to "streaming", but the live
    // assistant row may not exist yet (brief race). The fallback
    // !hasStreamingAssistantMessage keeps the dots visible.
    const streaming = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);
    expect(streaming.phase).toBe("streaming");
    expect(isThinking(streaming.phase)).toBe(false);
    expect(
      shouldShowThinkingIndicator(
        streaming.phase,
        streaming.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: false,
        },
      ),
    ).toBe(true);
  });

  test("hidden when streaming and assistant text is present", () => {
    const streaming = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "ASSISTANT_TEXT_DELTA" },
    ]);
    expect(
      shouldShowThinkingIndicator(
        streaming.phase,
        streaming.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: true,
        },
      ),
    ).toBe(false);
  });

  test("visible when thinking even if stale streaming message exists", () => {
    // macOS parity: isThinking short-circuits the streaming check.
    // A stale streaming flag from a prior turn should not block the
    // new turn's thinking indicator.
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    expect(
      shouldShowThinkingIndicator(
        thinking.phase,
        thinking.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: true,
        },
      ),
    ).toBe(true);
  });

  test("hidden when activeToolCallCount > 0", () => {
    const withTools = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "TOOL_USE_START" },
    ]);
    expect(
      shouldShowThinkingIndicator(
        withTools.phase,
        withTools.activeToolCallCount,
        defaultCtx,
      ),
    ).toBe(false);
  });

  test("hidden during awaiting_user_input when the matching pending flag is set (secret/confirmation/question/contact/surface)", () => {
    const awaiting = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "SECRET_REQUEST" },
    ]);
    expect(awaiting.phase).toBe("awaiting_user_input");
    expect(
      shouldShowThinkingIndicator(
        awaiting.phase,
        awaiting.activeToolCallCount,
        { ...defaultCtx, hasPendingSecret: true },
      ),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator(
        awaiting.phase,
        awaiting.activeToolCallCount,
        { ...defaultCtx, hasPendingConfirmation: true },
      ),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator(
        awaiting.phase,
        awaiting.activeToolCallCount,
        { ...defaultCtx, hasPendingQuestion: true },
      ),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator(
        awaiting.phase,
        awaiting.activeToolCallCount,
        { ...defaultCtx, hasPendingContactRequest: true },
      ),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator(
        awaiting.phase,
        awaiting.activeToolCallCount,
        { ...defaultCtx, hasUncompletedVisibleSurface: true },
      ),
    ).toBe(false);
  });

  test("hidden when idle", () => {
    expect(
      shouldShowThinkingIndicator(
        INITIAL_TURN_STATE.phase,
        INITIAL_TURN_STATE.activeToolCallCount,
        defaultCtx,
      ),
    ).toBe(false);
  });

  test("shows after switching back to a processing conversation that has no assistant response yet", () => {
    expect(
      shouldShowThinkingIndicator(
        INITIAL_TURN_STATE.phase,
        INITIAL_TURN_STATE.activeToolCallCount,
        {
          ...defaultCtx,
          activeConversationIsProcessing: true,
          hasPendingAssistantResponse: true,
        },
      ),
    ).toBe(true);
  });

  test("does not show restored processing dots once the conversation has assistant progress", () => {
    expect(
      shouldShowThinkingIndicator(
        INITIAL_TURN_STATE.phase,
        INITIAL_TURN_STATE.activeToolCallCount,
        {
          ...defaultCtx,
          activeConversationIsProcessing: true,
          hasPendingAssistantResponse: false,
        },
      ),
    ).toBe(false);
  });

  test("visible after ACTIVITY_STATE_THINKING even when streaming message exists", () => {
    // The exact scenario that caused the "agent not doing anything" complaint:
    // text streamed → tool call → tool completes → daemon sends thinking
    // activity_state → phase transitions back to thinking → dots re-appear
    // even though hasStreamingAssistantMessage is true.
    const afterTool = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "TOOL_USE_START" },
      { type: "TOOL_RESULT" },
      { type: "ACTIVITY_STATE_THINKING" },
    ]);
    expect(afterTool.phase).toBe("thinking");
    expect(
      shouldShowThinkingIndicator(
        afterTool.phase,
        afterTool.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: true,
        },
      ),
    ).toBe(true);
  });

  test("hidden once the live message has reasoning content (inline link owns it)", () => {
    // Same thinking phase as above, but the live assistant message has emitted
    // reasoning — an inline SingleActivity is now showing the loading state,
    // so the standalone dots row defers to avoid two competing indicators.
    const afterTool = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ASSISTANT_TEXT_DELTA" },
      { type: "TOOL_USE_START" },
      { type: "TOOL_RESULT" },
      { type: "ACTIVITY_STATE_THINKING" },
    ]);
    expect(afterTool.phase).toBe("thinking");
    expect(
      shouldShowThinkingIndicator(
        afterTool.phase,
        afterTool.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: true,
          hasStreamingAssistantThinking: true,
        },
      ),
    ).toBe(false);
  });

  test("still visible pre-reasoning: bubble exists but no thinking content yet", () => {
    // A streaming assistant bubble with no reasoning content → the inline link
    // isn't showing, so the standalone dots must remain to signal progress.
    const thinking = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED", turnId: "t-1" },
      { type: "ACTIVITY_STATE_THINKING" },
    ]);
    expect(
      shouldShowThinkingIndicator(
        thinking.phase,
        thinking.activeToolCallCount,
        {
          ...defaultCtx,
          hasStreamingAssistantMessage: true,
          hasStreamingAssistantThinking: false,
        },
      ),
    ).toBe(true);
  });

  test("restored processing dots do not compete with pending interaction UI", () => {
    expect(
      shouldShowThinkingIndicator(
        INITIAL_TURN_STATE.phase,
        INITIAL_TURN_STATE.activeToolCallCount,
        {
          ...defaultCtx,
          activeConversationIsProcessing: true,
          hasPendingAssistantResponse: true,
          hasPendingConfirmation: true,
        },
      ),
    ).toBe(false);
  });
});

describe("isSendDisabled", () => {
  test("enabled when sending (daemon queues messages)", () => {
    expect(isSendDisabled(defaultCtx)).toBe(false);
  });

  test("disabled when hasPendingSecret", () => {
    expect(
      isSendDisabled({
        ...defaultCtx,
        hasPendingSecret: true,
      }),
    ).toBe(true);
  });

  test("disabled when hasPendingConfirmation", () => {
    expect(
      isSendDisabled({
        ...defaultCtx,
        hasPendingConfirmation: true,
      }),
    ).toBe(true);
  });

  test("enabled when hasUncompletedVisibleSurface (sending implicitly dismisses)", () => {
    expect(
      isSendDisabled({
        ...defaultCtx,
        hasUncompletedVisibleSurface: true,
      }),
    ).toBe(false);
  });

  test("enabled when idle with no competing UI", () => {
    expect(isSendDisabled(defaultCtx)).toBe(false);
  });
});

describe("isAssistantBusy", () => {
  test("visible for a web-originated active turn", () => {
    const thinking = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
    });
    expect(isAssistantBusy(thinking.phase, defaultCtx)).toBe(true);
  });

  test("visible for an externally-originated streaming assistant message", () => {
    expect(
      isAssistantBusy(INITIAL_TURN_STATE.phase, {
        ...defaultCtx,
        hasStreamingAssistantMessage: true,
      }),
    ).toBe(true);
  });

  test("visible after switching back to a processing conversation", () => {
    expect(
      isAssistantBusy(INITIAL_TURN_STATE.phase, {
        ...defaultCtx,
        activeConversationIsProcessing: true,
      }),
    ).toBe(true);
  });

  test("hidden while waiting on a user-input surface", () => {
    const awaiting = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "CONFIRMATION_REQUEST" },
    ]);
    expect(
      isAssistantBusy(awaiting.phase, {
        ...defaultCtx,
        hasPendingConfirmation: true,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

describe("queue management", () => {
  test("MESSAGE_QUEUED increments pendingQueuedCount", () => {
    const s = turnReducer(INITIAL_TURN_STATE, { type: "MESSAGE_QUEUED" });
    expect(s.pendingQueuedCount).toBe(1);
    const s2 = turnReducer(s, { type: "MESSAGE_QUEUED" });
    expect(s2.pendingQueuedCount).toBe(2);
  });

  test("MESSAGE_DEQUEUED decrements pendingQueuedCount and sets phase to thinking", () => {
    const queued = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_QUEUED" },
    ]);
    const dequeued = turnReducer(queued, { type: "MESSAGE_DEQUEUED" });
    expect(dequeued.pendingQueuedCount).toBe(1);
    expect(dequeued.phase).toBe("thinking");
  });

  test("MESSAGE_QUEUED_DELETED decrements pendingQueuedCount", () => {
    const queued = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_QUEUED" },
    ]);
    const deleted = turnReducer(queued, { type: "MESSAGE_QUEUED_DELETED" });
    expect(deleted.pendingQueuedCount).toBe(1);
  });

  test("MESSAGE_COMPLETE transitions to 'queued' when pendingQueuedCount > 0", () => {
    const s = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(s.phase).toBe("queued");
    expect(s.pendingQueuedCount).toBe(1);
  });

  test("MESSAGE_QUEUED_DELETED returns to idle when last queued message deleted in 'queued' phase", () => {
    const queued = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(queued.phase).toBe("queued");
    const deleted = turnReducer(queued, { type: "MESSAGE_QUEUED_DELETED" });
    expect(deleted.phase).toBe("idle");
    expect(deleted.pendingQueuedCount).toBe(0);
    expect(deleted.activeTurnId).toBeNull();
  });

  test("MESSAGE_QUEUED_DELETED stays in 'queued' when more messages remain", () => {
    const queued = applyEvents(INITIAL_TURN_STATE, [
      { type: "USER_SEND_REQUESTED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_QUEUED" },
      { type: "MESSAGE_COMPLETE" },
    ]);
    expect(queued.phase).toBe("queued");
    const deleted = turnReducer(queued, { type: "MESSAGE_QUEUED_DELETED" });
    expect(deleted.phase).toBe("queued");
    expect(deleted.pendingQueuedCount).toBe(1);
  });

  test("stale MESSAGE_DEQUEUED in idle does not re-activate thinking", () => {
    const idle: TurnState = {
      ...INITIAL_TURN_STATE,
      pendingQueuedCount: 1,
    };
    const result = turnReducer(idle, { type: "MESSAGE_DEQUEUED" });
    expect(result.phase).toBe("idle");
    expect(result.pendingQueuedCount).toBe(0);
  });
});
