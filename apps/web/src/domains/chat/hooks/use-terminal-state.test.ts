import { describe, test } from "bun:test";

// These tests are written against the fully-implemented terminal state machine.
// The current file at domains/terminal/use-terminal-state.ts is a stub.
// Convert from test.todo to test once the terminal domain is fully ported.

describe("INITIAL_TERMINAL_STATE", () => {
  test.todo("starts idle with no error or session", () => {});
});

describe("happy-path connect flow", () => {
  test.todo("idle transitions to connecting on CONNECT_REQUESTED", () => {});
  test.todo("connecting transitions to connected on CONNECT_SUCCEEDED", () => {});
  test.todo("connected transitions to closed on TERMINAL_CLOSED", () => {});
});

describe("connect failure", () => {
  test.todo("connecting transitions to error on CONNECT_FAILED", () => {});
  test.todo("error state allows retry via CONNECT_REQUESTED", () => {});
});

describe("unexpected disconnect", () => {
  test.todo("connected transitions to error on DISCONNECTED", () => {});
});

describe("reconnect flow", () => {
  test.todo("error transitions to reconnecting on RECONNECT_REQUESTED", () => {});
  test.todo("reconnecting transitions to connected on RECONNECT_SUCCEEDED", () => {});
  test.todo("reconnecting increments attempt counter on each attempt", () => {});
  test.todo("reconnect resets attempt counter on success", () => {});
  test.todo("reconnecting transitions to error after RECONNECT_FAILED with max retries", () => {});
});

describe("output buffering", () => {
  test.todo("DATA_RECEIVED appends to output", () => {});
  test.todo("DATA_RECEIVED respects MAX_OUTPUT_LENGTH", () => {});
  test.todo("CLEAR_OUTPUT resets output to empty string", () => {});
});

describe("terminal reset", () => {
  test.todo("TERMINAL_RESET returns to initial state from any status", () => {});
});

describe("no-op transitions", () => {
  test.todo("returns same state for unhandled event/status combos", () => {});
});
