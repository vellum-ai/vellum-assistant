import { describe, test } from "bun:test";

// These tests are written against the fully-implemented terminal API and state machine.
// The current files at domains/terminal/api.ts and domains/terminal/use-terminal-state.ts
// are stubs. Convert from test.todo to test once the terminal domain is fully ported.

describe("connect flow", () => {
  test.todo("createTerminalSession returns a session ID", () => {});
  test.todo("state transitions idle -> connecting -> connected", () => {});
  test.todo("state transitions to error when connect fails", () => {});
});

describe("SSE stream subscription", () => {
  test.todo("subscribeTerminalEvents registers callbacks and returns cancel", () => {});
  test.todo("onEvent triggers DATA_RECEIVED state transitions", () => {});
  test.todo("onError triggers DISCONNECTED state transition", () => {});
});

describe("input and resize", () => {
  test.todo("sendTerminalInput sends data to the correct session", () => {});
  test.todo("resizeTerminal sends dimensions to the correct session", () => {});
});

describe("disconnect flow", () => {
  test.todo("destroyTerminalSession cleans up the session", () => {});
  test.todo("cancel function from subscribeTerminalEvents stops the stream", () => {});
});

describe("reconnect flow", () => {
  test.todo("reconnect creates a new session after disconnect", () => {});
  test.todo("reconnect re-subscribes to SSE events", () => {});
  test.todo("reconnect increments attempt counter", () => {});
});

describe("error recovery", () => {
  test.todo("graceful degradation when SSE stream errors", () => {});
  test.todo("session cleanup on unmount", () => {});
});
