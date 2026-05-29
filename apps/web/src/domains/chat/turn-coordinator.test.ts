import { beforeEach, describe, expect, test } from "bun:test";

import { useConversationStore } from "@/stores/conversation-store";
import {
  INITIAL_TURN_STATE,
  useTurnStore,
  type TurnState,
} from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";

function seedActiveTurn(overrides?: Partial<TurnState>): void {
  useTurnStore.setState({
    ...INITIAL_TURN_STATE,
    phase: "thinking",
    activeTurnId: "turn-42",
    ...overrides,
  });
}

function seedProcessing(conversationId: string): void {
  useConversationStore.setState({
    processingConversationIds: new Set([conversationId]),
  });
}

beforeEach(() => {
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    attentionConversationIds: new Set(),
  });
});

describe("endTurn — turn-store transition", () => {
  test("'complete' calls completeTurn() and idles the turn", () => {
    seedActiveTurn();
    endTurn({ conversationId: "conv-1", reason: "complete" });
    const state = useTurnStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("'cancelled' calls cancelGeneration() and records the reason", () => {
    seedActiveTurn();
    endTurn({ conversationId: "conv-1", reason: "cancelled" });
    const state = useTurnStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("cancelled");
  });

  test("'error' calls onStreamError() and records the reason", () => {
    seedActiveTurn();
    endTurn({ conversationId: "conv-1", reason: "error" });
    expect(useTurnStore.getState().lastTerminalReason).toBe("error");
  });

  test("'session_error' calls onSessionError() and records the reason", () => {
    seedActiveTurn();
    endTurn({ conversationId: "conv-1", reason: "session_error" });
    expect(useTurnStore.getState().lastTerminalReason).toBe("session_error");
  });

  test("'rescued' forwards rescuedTurnId to onPollReconciled (matching turn → idles)", () => {
    seedActiveTurn({ activeTurnId: "turn-42" });
    endTurn({
      conversationId: "conv-1",
      reason: "rescued",
      rescuedTurnId: "turn-42",
    });
    const state = useTurnStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.lastTerminalReason).toBe("complete");
  });

  test("'rescued' with mismatched turnId leaves the active turn untouched", () => {
    // Defensive: the silent-stall rescue must scope to the turn that
    // was in flight when the fetch dispatched. If the user started a
    // new turn during the async window, the old rescue's resolution
    // must not idle the new turn.
    seedActiveTurn({ activeTurnId: "turn-new" });
    endTurn({
      conversationId: "conv-1",
      reason: "rescued",
      rescuedTurnId: "turn-stale",
    });
    const state = useTurnStore.getState();
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("turn-new");
  });

  test("'rescued' that no-ops also leaves the processing key untouched", () => {
    // The bug being guarded: a stale `.finally()` from a previous send's
    // poll/reconcile fires after the user has started a new turn in
    // the same conversation. `onPollReconciled` correctly no-ops on
    // turnId mismatch — but if the processing-key clear fires anyway,
    // it would hide the Stop button + sidebar dot for the NEW in-flight
    // turn. The coordinator must gate the processing-key clear on
    // whether the turn-store actually transitioned.
    seedActiveTurn({ activeTurnId: "turn-new" });
    seedProcessing("conv-1");
    endTurn({
      conversationId: "conv-1",
      reason: "rescued",
      rescuedTurnId: "turn-stale",
    });
    // Turn-store untouched (mismatched turnId).
    expect(useTurnStore.getState().activeTurnId).toBe("turn-new");
    // Critical: the in-flight turn's processing key must NOT be cleared.
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(true);
  });

  test("'rescued' that fires when the turn is already idle is a full no-op", () => {
    // `onPollReconciled`'s `if (!isSending(s)) return` short-circuits
    // when the turn has already settled via the SSE terminal path.
    // The processing key clear must also be skipped — otherwise a
    // late-arriving rescue could clear a key that has since been
    // re-added by a subsequent send.
    useTurnStore.setState({ ...INITIAL_TURN_STATE, phase: "idle" });
    seedProcessing("conv-1");
    endTurn({
      conversationId: "conv-1",
      reason: "rescued",
      rescuedTurnId: "turn-42",
    });
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(true);
  });
});

describe("endTurn — processing-key cleanup", () => {
  test("removes conversationId from processingConversationIds", () => {
    seedActiveTurn();
    seedProcessing("conv-1");
    endTurn({ conversationId: "conv-1", reason: "complete" });
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
  });

  test("only removes the supplied conversationId — other in-flight conversations stay", () => {
    seedActiveTurn();
    useConversationStore.setState({
      processingConversationIds: new Set(["conv-1", "conv-bg"]),
    });
    endTurn({ conversationId: "conv-1", reason: "complete" });
    const ids = useConversationStore.getState().processingConversationIds;
    expect(ids.has("conv-1")).toBe(false);
    expect(ids.has("conv-bg")).toBe(true);
  });

  test("no-op processing-key clear when conversationId is null/undefined (turn-store still transitions)", () => {
    // Some terminal events (e.g. stream errors mid-teardown) can't
    // identify the conversation. The turn-store transition still
    // fires; the processing-key clear is skipped.
    seedActiveTurn();
    seedProcessing("conv-1");
    endTurn({ conversationId: null, reason: "error" });
    expect(useTurnStore.getState().lastTerminalReason).toBe("error");
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(true);
  });
});
