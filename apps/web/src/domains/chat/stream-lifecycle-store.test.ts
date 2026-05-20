import { describe, expect, test } from "bun:test";

import {
  INITIAL_STREAM_LIFECYCLE_STATE,
  isStreamConnecting,
  isStreamOpen,
  isStreamPaused,
  streamLifecycleReducer,
  type DomainEvent,
  type StreamContext,
  type StreamLifecycleState,
} from "@/domains/chat/stream-lifecycle-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a sequence of events to a state, returning the final state. */
function applyEvents(
  state: StreamLifecycleState,
  events: DomainEvent[],
): StreamLifecycleState {
  return events.reduce(streamLifecycleReducer, state);
}

const ctxA: StreamContext = {
  assistantId: "asst-a",
  conversationKey: "conv-1",
};

const ctxB: StreamContext = {
  assistantId: "asst-a",
  conversationKey: "conv-2",
};

/** Walk from `closed` to a target phase using minimum events. */
function openedState(context: StreamContext = ctxA): StreamLifecycleState {
  return applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
    { type: "OPEN_REQUEST", context },
    { type: "OPEN_SUCCESS", epoch: 1 },
  ]);
}

function openingState(context: StreamContext = ctxA): StreamLifecycleState {
  return streamLifecycleReducer(INITIAL_STREAM_LIFECYCLE_STATE, {
    type: "OPEN_REQUEST",
    context,
  });
}

function retryingState(context: StreamContext = ctxA): StreamLifecycleState {
  return applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
    { type: "OPEN_REQUEST", context },
    { type: "OPEN_FAILURE", epoch: 1, message: "boom" },
  ]);
}

function waitingState(context: StreamContext = ctxA): StreamLifecycleState {
  return applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
    { type: "OPEN_REQUEST", context },
    { type: "OPEN_SUCCESS", epoch: 1 },
    { type: "APP_LIFECYCLE_CHANGE", source: "visibility", online: false },
  ]);
}

function reconcilingState(context: StreamContext = ctxA): StreamLifecycleState {
  return applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
    { type: "OPEN_REQUEST", context },
    { type: "OPEN_SUCCESS", epoch: 1 },
    { type: "RECONCILE_REQUEST" },
  ]);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("INITIAL_STREAM_LIFECYCLE_STATE", () => {
  test("starts closed with no context, no failures, epoch 0", () => {
    expect(INITIAL_STREAM_LIFECYCLE_STATE.phase).toBe("closed");
    expect(INITIAL_STREAM_LIFECYCLE_STATE.epoch).toBe(0);
    expect(INITIAL_STREAM_LIFECYCLE_STATE.consecutiveFailures).toBe(0);
    expect(INITIAL_STREAM_LIFECYCLE_STATE.context).toBeNull();
    expect(INITIAL_STREAM_LIFECYCLE_STATE.lastError).toBeNull();
  });

  test("derived predicates report inactive lifecycle", () => {
    expect(isStreamOpen(INITIAL_STREAM_LIFECYCLE_STATE)).toBe(false);
    expect(isStreamConnecting(INITIAL_STREAM_LIFECYCLE_STATE)).toBe(false);
    expect(isStreamPaused(INITIAL_STREAM_LIFECYCLE_STATE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

describe("derived helpers", () => {
  test("isStreamOpen is true only in 'open'", () => {
    expect(isStreamOpen(openedState())).toBe(true);
    expect(isStreamOpen(openingState())).toBe(false);
    expect(isStreamOpen(retryingState())).toBe(false);
    expect(isStreamOpen(waitingState())).toBe(false);
    expect(isStreamOpen(reconcilingState())).toBe(false);
  });

  test("isStreamConnecting is true in 'opening' and 'reconciling'", () => {
    expect(isStreamConnecting(openingState())).toBe(true);
    expect(isStreamConnecting(reconcilingState())).toBe(true);
    expect(isStreamConnecting(openedState())).toBe(false);
    expect(isStreamConnecting(retryingState())).toBe(false);
    expect(isStreamConnecting(waitingState())).toBe(false);
  });

  test("isStreamPaused is true in 'waiting' and 'retrying'", () => {
    expect(isStreamPaused(waitingState())).toBe(true);
    expect(isStreamPaused(retryingState())).toBe(true);
    expect(isStreamPaused(openedState())).toBe(false);
    expect(isStreamPaused(openingState())).toBe(false);
    expect(isStreamPaused(reconcilingState())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OPEN_REQUEST
// ---------------------------------------------------------------------------

describe("OPEN_REQUEST", () => {
  test("transitions closed → opening, bumping epoch and setting context", () => {
    const state = streamLifecycleReducer(INITIAL_STREAM_LIFECYCLE_STATE, {
      type: "OPEN_REQUEST",
      context: ctxA,
    });
    expect(state.phase).toBe("opening");
    expect(state.epoch).toBe(1);
    expect(state.context).toEqual(ctxA);
    expect(state.lastError).toBeNull();
  });

  test("clears lastError carried over from a prior failure", () => {
    const erroredFromRetry: StreamLifecycleState = {
      ...retryingState(),
    };
    expect(erroredFromRetry.lastError).toBe("boom");
    const next = streamLifecycleReducer(erroredFromRetry, {
      type: "OPEN_REQUEST",
      context: ctxA,
    });
    expect(next.phase).toBe("opening");
    expect(next.lastError).toBeNull();
  });

  test("dedups same-context request while opening", () => {
    const opening = openingState(ctxA);
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_REQUEST",
      context: { ...ctxA },
    });
    expect(next).toBe(opening);
  });

  test("dedups same-context request while open", () => {
    const open = openedState(ctxA);
    const next = streamLifecycleReducer(open, {
      type: "OPEN_REQUEST",
      context: { ...ctxA },
    });
    expect(next).toBe(open);
  });

  test("conversation switch while open re-opens with bumped epoch", () => {
    const open = openedState(ctxA);
    const next = streamLifecycleReducer(open, {
      type: "OPEN_REQUEST",
      context: ctxB,
    });
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(open.epoch + 1);
    expect(next.context).toEqual(ctxB);
  });

  test("conversation switch while opening replaces context and bumps epoch", () => {
    const opening = openingState(ctxA);
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_REQUEST",
      context: ctxB,
    });
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(opening.epoch + 1);
    expect(next.context).toEqual(ctxB);
  });

  test("from retrying: manual retry transitions to opening and clears lastError", () => {
    const retrying = retryingState();
    const next = streamLifecycleReducer(retrying, {
      type: "OPEN_REQUEST",
      context: ctxA,
    });
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(retrying.epoch + 1);
    expect(next.lastError).toBeNull();
    expect(next.consecutiveFailures).toBe(retrying.consecutiveFailures);
  });

  test("from waiting: explicit open transitions to opening", () => {
    const waiting = waitingState();
    const next = streamLifecycleReducer(waiting, {
      type: "OPEN_REQUEST",
      context: ctxA,
    });
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(waiting.epoch + 1);
  });

  test("from reconciling: OPEN_REQUEST overrides pending reconcile and transitions to opening", () => {
    const reconciling = reconcilingState();
    const next = streamLifecycleReducer(reconciling, {
      type: "OPEN_REQUEST",
      context: ctxA,
    });
    // The dedup guard only fires for `opening` / `open`, so reconciling
    // falls through and we transition to `opening` (epoch bumped). An
    // explicit open overrides any pending reconcile.
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(reconciling.epoch + 1);
  });
});

// ---------------------------------------------------------------------------
// OPEN_SUCCESS
// ---------------------------------------------------------------------------

describe("OPEN_SUCCESS", () => {
  test("opening → open and resets consecutiveFailures", () => {
    const opening = streamLifecycleReducer(
      { ...INITIAL_STREAM_LIFECYCLE_STATE, consecutiveFailures: 4 },
      { type: "OPEN_REQUEST", context: ctxA },
    );
    expect(opening.consecutiveFailures).toBe(4);
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_SUCCESS",
      epoch: opening.epoch,
    });
    expect(next.phase).toBe("open");
    expect(next.consecutiveFailures).toBe(0);
    expect(next.lastError).toBeNull();
  });

  test("ignores stale epoch (callback from a prior open attempt)", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_SUCCESS",
      epoch: opening.epoch - 1,
    });
    expect(next).toBe(opening);
  });

  test("no-op when not in opening phase", () => {
    const open = openedState();
    const next = streamLifecycleReducer(open, {
      type: "OPEN_SUCCESS",
      epoch: open.epoch,
    });
    expect(next).toBe(open);
  });
});

// ---------------------------------------------------------------------------
// OPEN_FAILURE
// ---------------------------------------------------------------------------

describe("OPEN_FAILURE", () => {
  test("opening → retrying, increments consecutiveFailures, records error", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_FAILURE",
      epoch: opening.epoch,
      message: "fetch failed",
    });
    expect(next.phase).toBe("retrying");
    expect(next.consecutiveFailures).toBe(1);
    expect(next.lastError).toBe("fetch failed");
  });

  test("open → retrying when stream errors mid-flight", () => {
    const open = openedState();
    const next = streamLifecycleReducer(open, {
      type: "OPEN_FAILURE",
      epoch: open.epoch,
      message: "stream ended",
    });
    expect(next.phase).toBe("retrying");
    expect(next.consecutiveFailures).toBe(1);
    expect(next.lastError).toBe("stream ended");
  });

  test("accumulates consecutiveFailures across repeated failures", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_FAILURE", epoch: 1, message: "first" },
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_FAILURE", epoch: 2, message: "second" },
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_FAILURE", epoch: 3, message: "third" },
    ]);
    expect(final.phase).toBe("retrying");
    expect(final.consecutiveFailures).toBe(3);
    expect(final.lastError).toBe("third");
  });

  test("ignores stale epoch", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, {
      type: "OPEN_FAILURE",
      epoch: opening.epoch - 1,
      message: "stale",
    });
    expect(next).toBe(opening);
  });

  test("no-op from closed/waiting/retrying/reconciling", () => {
    for (const state of [
      INITIAL_STREAM_LIFECYCLE_STATE,
      waitingState(),
      retryingState(),
      reconcilingState(),
    ]) {
      const next = streamLifecycleReducer(state, {
        type: "OPEN_FAILURE",
        epoch: state.epoch,
        message: "shouldn't apply",
      });
      expect(next).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// RECONCILE_REQUEST
// ---------------------------------------------------------------------------

describe("RECONCILE_REQUEST", () => {
  test("open → reconciling (canonical pending-edits-before-reopen path)", () => {
    const open = openedState();
    const next = streamLifecycleReducer(open, { type: "RECONCILE_REQUEST" });
    expect(next.phase).toBe("reconciling");
    // Epoch is NOT bumped here — that happens on RECONCILE_SUCCESS so
    // the new open attempt gets its own clean epoch.
    expect(next.epoch).toBe(open.epoch);
  });

  test("opening → reconciling", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, { type: "RECONCILE_REQUEST" });
    expect(next.phase).toBe("reconciling");
  });

  test("waiting → reconciling", () => {
    const waiting = waitingState();
    const next = streamLifecycleReducer(waiting, { type: "RECONCILE_REQUEST" });
    expect(next.phase).toBe("reconciling");
  });

  test("retrying → reconciling", () => {
    const retrying = retryingState();
    const next = streamLifecycleReducer(retrying, {
      type: "RECONCILE_REQUEST",
    });
    expect(next.phase).toBe("reconciling");
  });

  test("closed: no-op (nothing pending, nothing to reopen)", () => {
    const next = streamLifecycleReducer(INITIAL_STREAM_LIFECYCLE_STATE, {
      type: "RECONCILE_REQUEST",
    });
    expect(next).toBe(INITIAL_STREAM_LIFECYCLE_STATE);
  });

  test("reconciling: no-op (already reconciling)", () => {
    const reconciling = reconcilingState();
    const next = streamLifecycleReducer(reconciling, {
      type: "RECONCILE_REQUEST",
    });
    expect(next).toBe(reconciling);
  });
});

// ---------------------------------------------------------------------------
// RECONCILE_SUCCESS
// ---------------------------------------------------------------------------

describe("RECONCILE_SUCCESS", () => {
  test("reconciling → opening with a fresh epoch", () => {
    const reconciling = reconcilingState();
    const next = streamLifecycleReducer(reconciling, {
      type: "RECONCILE_SUCCESS",
    });
    expect(next.phase).toBe("opening");
    expect(next.epoch).toBe(reconciling.epoch + 1);
    expect(next.lastError).toBeNull();
  });

  test("no-op from any phase that isn't reconciling", () => {
    for (const state of [
      INITIAL_STREAM_LIFECYCLE_STATE,
      openingState(),
      openedState(),
      waitingState(),
      retryingState(),
    ]) {
      const next = streamLifecycleReducer(state, {
        type: "RECONCILE_SUCCESS",
      });
      expect(next).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// RECONCILE_FAILURE
// ---------------------------------------------------------------------------

describe("RECONCILE_FAILURE", () => {
  test("reconciling → retrying, increments failures, records error", () => {
    const reconciling = reconcilingState();
    const baseFailures = reconciling.consecutiveFailures;
    const next = streamLifecycleReducer(reconciling, {
      type: "RECONCILE_FAILURE",
      message: "reconcile fetch errored",
    });
    expect(next.phase).toBe("retrying");
    expect(next.consecutiveFailures).toBe(baseFailures + 1);
    expect(next.lastError).toBe("reconcile fetch errored");
  });

  test("no-op from any phase that isn't reconciling", () => {
    for (const state of [
      INITIAL_STREAM_LIFECYCLE_STATE,
      openingState(),
      openedState(),
      waitingState(),
      retryingState(),
    ]) {
      const next = streamLifecycleReducer(state, {
        type: "RECONCILE_FAILURE",
        message: "shouldn't apply",
      });
      expect(next).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// CLOSE_REQUEST
// ---------------------------------------------------------------------------

describe("CLOSE_REQUEST", () => {
  test("from any non-closed phase transitions to closed and clears context", () => {
    for (const state of [
      openingState(),
      openedState(),
      waitingState(),
      retryingState(),
      reconcilingState(),
    ]) {
      const next = streamLifecycleReducer(state, {
        type: "CLOSE_REQUEST",
        source: "unmount",
      });
      expect(next.phase).toBe("closed");
      expect(next.context).toBeNull();
    }
  });

  test("close from closed remains closed (idempotent)", () => {
    const next = streamLifecycleReducer(INITIAL_STREAM_LIFECYCLE_STATE, {
      type: "CLOSE_REQUEST",
      source: "unmount",
    });
    expect(next.phase).toBe("closed");
    expect(next.context).toBeNull();
  });

  test("preserves consecutiveFailures so a later retry can use the counter", () => {
    const retrying = retryingState();
    expect(retrying.consecutiveFailures).toBe(1);
    const next = streamLifecycleReducer(retrying, {
      type: "CLOSE_REQUEST",
      source: "deps_changed",
    });
    expect(next.consecutiveFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// APP_LIFECYCLE_CHANGE — going offline / backgrounded
// ---------------------------------------------------------------------------

describe("APP_LIFECYCLE_CHANGE (online=false)", () => {
  test("open → waiting", () => {
    const open = openedState();
    const next = streamLifecycleReducer(open, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: false,
    });
    expect(next.phase).toBe("waiting");
    expect(next.epoch).toBe(open.epoch);
  });

  test("opening → waiting, bumps epoch so in-flight callbacks become stale", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "app_state",
      online: false,
    });
    expect(next.phase).toBe("waiting");
    expect(next.epoch).toBe(opening.epoch + 1);
  });

  test("dedups on already-paused phases (waiting, retrying)", () => {
    for (const state of [waitingState(), retryingState()]) {
      const next = streamLifecycleReducer(state, {
        type: "APP_LIFECYCLE_CHANGE",
        source: "reachability",
        online: false,
      });
      expect(next).toBe(state);
    }
  });

  test("dedups from closed and reconciling", () => {
    for (const state of [INITIAL_STREAM_LIFECYCLE_STATE, reconcilingState()]) {
      const next = streamLifecycleReducer(state, {
        type: "APP_LIFECYCLE_CHANGE",
        source: "visibility",
        online: false,
      });
      expect(next).toBe(state);
    }
  });

  test("dedup across sources: a second offline signal within the same paused phase is a no-op", () => {
    // Visibility hidden then Capacitor app_state inactive — the
    // pre-existing bug was a 1s clock-based dedup race; here the state
    // alone gates the transition.
    const afterFirst = streamLifecycleReducer(openedState(), {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: false,
    });
    const afterSecond = streamLifecycleReducer(afterFirst, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "app_state",
      online: false,
    });
    expect(afterSecond).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// APP_LIFECYCLE_CHANGE — coming online / foregrounded
// ---------------------------------------------------------------------------

describe("APP_LIFECYCLE_CHANGE (online=true)", () => {
  test("waiting → reconciling (resume reconciles before reopening)", () => {
    const waiting = waitingState();
    const next = streamLifecycleReducer(waiting, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: true,
    });
    expect(next.phase).toBe("reconciling");
  });

  test("retrying → reconciling on a reachability flip", () => {
    const retrying = retryingState();
    const next = streamLifecycleReducer(retrying, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "reachability",
      online: true,
    });
    expect(next.phase).toBe("reconciling");
  });

  test("no-op while already opening", () => {
    const opening = openingState();
    const next = streamLifecycleReducer(opening, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: true,
    });
    expect(next).toBe(opening);
  });

  test("no-op while already open", () => {
    const open = openedState();
    const next = streamLifecycleReducer(open, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: true,
    });
    expect(next).toBe(open);
  });

  test("no-op while reconciling", () => {
    const reconciling = reconcilingState();
    const next = streamLifecycleReducer(reconciling, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: true,
    });
    expect(next).toBe(reconciling);
  });

  test("no-op from closed (an explicit OPEN_REQUEST is required to start)", () => {
    const next = streamLifecycleReducer(INITIAL_STREAM_LIFECYCLE_STATE, {
      type: "APP_LIFECYCLE_CHANGE",
      source: "visibility",
      online: true,
    });
    expect(next).toBe(INITIAL_STREAM_LIFECYCLE_STATE);
  });
});

// ---------------------------------------------------------------------------
// Canonical event sequences (end-to-end transition coverage)
// ---------------------------------------------------------------------------

describe("canonical sequences", () => {
  test("happy path: closed → opening → open", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.epoch).toBe(1);
    expect(final.consecutiveFailures).toBe(0);
    expect(final.context).toEqual(ctxA);
  });

  test("transient failure then recovery: open → retrying → reconciling → opening → open", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
      { type: "OPEN_FAILURE", epoch: 1, message: "network blip" },
      { type: "APP_LIFECYCLE_CHANGE", source: "reachability", online: true },
      { type: "RECONCILE_SUCCESS" },
      { type: "OPEN_SUCCESS", epoch: 2 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.consecutiveFailures).toBe(0);
    expect(final.lastError).toBeNull();
  });

  test("backgrounded then resumed: open → waiting → reconciling → opening → open", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
      { type: "APP_LIFECYCLE_CHANGE", source: "app_state", online: false },
      { type: "APP_LIFECYCLE_CHANGE", source: "app_state", online: true },
      { type: "RECONCILE_SUCCESS" },
      { type: "OPEN_SUCCESS", epoch: 2 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.epoch).toBe(2);
  });

  test("conversationExistsOnServer flips: reconcile fires before reopen", () => {
    // The pre-existing bug was that flipping the flag mid-stream re-opened
    // without reconciling pending local edits. The state machine enforces
    // RECONCILE first, then reopen.
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
      { type: "RECONCILE_REQUEST" },
      { type: "RECONCILE_SUCCESS" },
      { type: "OPEN_SUCCESS", epoch: 2 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.epoch).toBe(2);
  });

  test("stale OPEN_SUCCESS arriving after a teardown is ignored", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      // Teardown while opening (page hidden) bumps epoch.
      { type: "APP_LIFECYCLE_CHANGE", source: "visibility", online: false },
      // The original open's fetch finally resolves — but with the
      // pre-teardown epoch. The reducer must ignore it.
      { type: "OPEN_SUCCESS", epoch: 1 },
    ]);
    expect(final.phase).toBe("waiting");
  });

  test("backoff counter accumulates across failures, resets on success", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_FAILURE", epoch: 1, message: "1" },
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_FAILURE", epoch: 2, message: "2" },
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 3 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.consecutiveFailures).toBe(0);
    expect(final.lastError).toBeNull();
  });

  test("conversation switch while open: re-opens with new context", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
      { type: "OPEN_REQUEST", context: ctxB },
      { type: "OPEN_SUCCESS", epoch: 2 },
    ]);
    expect(final.phase).toBe("open");
    expect(final.context).toEqual(ctxB);
    expect(final.epoch).toBe(2);
  });

  test("unmount during reconciling: lands in closed regardless", () => {
    const final = applyEvents(INITIAL_STREAM_LIFECYCLE_STATE, [
      { type: "OPEN_REQUEST", context: ctxA },
      { type: "OPEN_SUCCESS", epoch: 1 },
      { type: "RECONCILE_REQUEST" },
      { type: "CLOSE_REQUEST", source: "unmount" },
      // Reconcile resolves after unmount — must be a no-op.
      { type: "RECONCILE_SUCCESS" },
    ]);
    expect(final.phase).toBe("closed");
    expect(final.context).toBeNull();
  });
});
