import { describe, expect, test } from "bun:test";

import {
  INITIAL_TERMINAL_STATE,
  terminalReducer,
  type TerminalEvent,
  type TerminalState,
} from "@/domains/chat/hooks/use-terminal-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyEvents(events: TerminalEvent[], initial: TerminalState = INITIAL_TERMINAL_STATE): TerminalState {
  return events.reduce(terminalReducer, initial);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("INITIAL_TERMINAL_STATE", () => {
  test("starts idle with no error or session", () => {
    expect(INITIAL_TERMINAL_STATE.status).toBe("idle");
    expect(INITIAL_TERMINAL_STATE.errorMessage).toBeNull();
    expect(INITIAL_TERMINAL_STATE.reconnectAttempts).toBe(0);
    expect(INITIAL_TERMINAL_STATE.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happy-path: idle -> connecting -> connected -> closed
// ---------------------------------------------------------------------------

describe("happy-path connect flow", () => {
  test("idle transitions to connecting on CONNECT_REQUESTED", () => {
    const state = terminalReducer(INITIAL_TERMINAL_STATE, { type: "CONNECT_REQUESTED" });
    expect(state.status).toBe("connecting");
    expect(state.errorMessage).toBeNull();
    expect(state.reconnectAttempts).toBe(0);
  });

  test("connecting transitions to connected on CONNECT_SUCCEEDED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-abc" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.sessionId).toBe("sess-abc");
    expect(state.errorMessage).toBeNull();
  });

  test("connected transitions to closed on TERMINAL_CLOSED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-abc" },
      { type: "TERMINAL_CLOSED" },
    ]);
    expect(state.status).toBe("closed");
    expect(state.sessionId).toBeNull();
    expect(state.errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connect failure
// ---------------------------------------------------------------------------

describe("connect failure", () => {
  test("connecting transitions to error on CONNECT_FAILED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "Connection refused" },
    ]);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Connection refused");
    expect(state.sessionId).toBeNull();
  });

  test("error state allows retry via CONNECT_REQUESTED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "Timeout" },
      { type: "CONNECT_REQUESTED" },
    ]);
    expect(state.status).toBe("connecting");
    expect(state.errorMessage).toBeNull();
    expect(state.reconnectAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unexpected disconnect (connection drop while connected)
// ---------------------------------------------------------------------------

describe("unexpected disconnect", () => {
  test("connected transitions to error on DISCONNECTED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
    ]);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Connection lost.");
    expect(state.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect flow
// ---------------------------------------------------------------------------

describe("reconnect flow", () => {
  test("error transitions to reconnecting on RECONNECT_REQUESTED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
    ]);
    expect(state.status).toBe("reconnecting");
    expect(state.reconnectAttempts).toBe(1);
    expect(state.sessionId).toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  test("reconnecting transitions to connected on RECONNECT_SUCCEEDED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_SUCCEEDED", sessionId: "sess-2" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.sessionId).toBe("sess-2");
    expect(state.errorMessage).toBeNull();
  });

  test("reconnecting transitions to error on RECONNECT_FAILED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_FAILED", message: "Server unreachable" },
    ]);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Server unreachable");
    expect(state.sessionId).toBeNull();
  });

  test("reconnect attempt count increments on each RECONNECT_REQUESTED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_FAILED", message: "fail" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_FAILED", message: "fail again" },
    ]);
    expect(state.reconnectAttempts).toBe(2);
  });

  test("reconnect attempt count resets to 0 after RECONNECT_SUCCEEDED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_FAILED", message: "fail" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_SUCCEEDED", sessionId: "sess-3" },
    ]);
    expect(state.status).toBe("connected");
    expect(state.sessionId).toBe("sess-3");
    expect(state.reconnectAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ERROR_OCCURRED — generic error signal (e.g. from output stream)
// ---------------------------------------------------------------------------

describe("ERROR_OCCURRED", () => {
  test("connected transitions to error on ERROR_OCCURRED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "ERROR_OCCURRED", message: "Pod evicted" },
    ]);
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Pod evicted");
    expect(state.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_RESET — clears all state back to initial
// ---------------------------------------------------------------------------

describe("TERMINAL_RESET", () => {
  test("resets to initial state from error", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "fail" },
      { type: "TERMINAL_RESET" },
    ]);
    expect(state).toEqual(INITIAL_TERMINAL_STATE);
  });

  test("resets to initial state from connected", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "TERMINAL_RESET" },
    ]);
    expect(state).toEqual(INITIAL_TERMINAL_STATE);
  });
});

// ---------------------------------------------------------------------------
// Guard: no-op transitions (invalid event for current status)
// ---------------------------------------------------------------------------

describe("no-op transitions", () => {
  test("CONNECT_REQUESTED is ignored when already connected", () => {
    const connected = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
    ]);
    const after = terminalReducer(connected, { type: "CONNECT_REQUESTED" });
    expect(after).toEqual(connected);
  });

  test("CONNECT_REQUESTED is ignored when connecting", () => {
    const connecting = terminalReducer(INITIAL_TERMINAL_STATE, { type: "CONNECT_REQUESTED" });
    const after = terminalReducer(connecting, { type: "CONNECT_REQUESTED" });
    expect(after).toEqual(connecting);
  });

  test("CONNECT_SUCCEEDED is ignored when not connecting", () => {
    const after = terminalReducer(INITIAL_TERMINAL_STATE, {
      type: "CONNECT_SUCCEEDED",
      sessionId: "sess-x",
    });
    expect(after).toEqual(INITIAL_TERMINAL_STATE);
  });

  test("RECONNECT_REQUESTED is ignored when idle", () => {
    const after = terminalReducer(INITIAL_TERMINAL_STATE, { type: "RECONNECT_REQUESTED" });
    expect(after).toEqual(INITIAL_TERMINAL_STATE);
  });

  test("RECONNECT_REQUESTED is ignored when connecting", () => {
    const connecting = terminalReducer(INITIAL_TERMINAL_STATE, { type: "CONNECT_REQUESTED" });
    const after = terminalReducer(connecting, { type: "RECONNECT_REQUESTED" });
    expect(after).toEqual(connecting);
  });

  test("DISCONNECTED is ignored when already idle", () => {
    const after = terminalReducer(INITIAL_TERMINAL_STATE, { type: "DISCONNECTED" });
    expect(after).toEqual(INITIAL_TERMINAL_STATE);
  });

  test("RECONNECT_FAILED is ignored when not reconnecting", () => {
    const after = terminalReducer(INITIAL_TERMINAL_STATE, {
      type: "RECONNECT_FAILED",
      message: "stale",
    });
    expect(after).toEqual(INITIAL_TERMINAL_STATE);
  });
});

// ---------------------------------------------------------------------------
// TerminalState type coverage — discriminated union
// ---------------------------------------------------------------------------

describe("TerminalStatus type coverage", () => {
  const statuses: TerminalState["status"][] = [
    "idle",
    "connecting",
    "connected",
    "reconnecting",
    "error",
    "closed",
  ];

  test.each(statuses)("status '%s' is a valid TerminalStatus", (status) => {
    const state: TerminalState = {
      ...INITIAL_TERMINAL_STATE,
      status,
    };
    expect(state.status).toBe(status);
  });
});

// ---------------------------------------------------------------------------
// Reconnect edge cases
// ---------------------------------------------------------------------------

describe("reconnect edge cases", () => {
  test("multiple disconnect-reconnect cycles accumulate attempt count", () => {
    // First reconnect cycle: fail
    const afterFirstCycle = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "DISCONNECTED" },
      { type: "RECONNECT_REQUESTED" },
      { type: "RECONNECT_FAILED", message: "fail" },
    ]);
    expect(afterFirstCycle.reconnectAttempts).toBe(1);

    // Second attempt from error
    const afterSecond = applyEvents(
      [{ type: "RECONNECT_REQUESTED" }, { type: "RECONNECT_FAILED", message: "fail again" }],
      afterFirstCycle,
    );
    expect(afterSecond.reconnectAttempts).toBe(2);
  });

  test("closed state allows fresh CONNECT_REQUESTED", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "TERMINAL_CLOSED" },
      { type: "CONNECT_REQUESTED" },
    ]);
    expect(state.status).toBe("connecting");
    expect(state.reconnectAttempts).toBe(0);
  });

  test("connected state allows RECONNECT_REQUESTED (manual reconnect)", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_SUCCEEDED", sessionId: "sess-1" },
      { type: "RECONNECT_REQUESTED" },
    ]);
    expect(state.status).toBe("reconnecting");
    expect(state.reconnectAttempts).toBe(1);
  });

  test("CONNECT_FAILED clears errorMessage from previous cycle before setting new one", () => {
    const state = applyEvents([
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "first error" },
      { type: "CONNECT_REQUESTED" },
      { type: "CONNECT_FAILED", message: "second error" },
    ]);
    expect(state.errorMessage).toBe("second error");
  });
});
