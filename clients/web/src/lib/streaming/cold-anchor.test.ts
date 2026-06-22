import { beforeEach, describe, expect, mock, test } from "bun:test";

// Single global cursor mock mirroring reconnect-cursor.ts's full export
// surface, so this mock doesn't shadow the real module's other exports
// when bun shares a process across test files.
let globalCursor: number | null = null;
mock.module("@/lib/streaming/reconnect-cursor", () => ({
  getReconnectCursor: () => globalCursor,
  // Monotonic — matches the real implementation (won't lower the cursor).
  advanceReconnectCursor: (seq: number) => {
    if (globalCursor === null || seq > globalCursor) {
      globalCursor = seq;
    }
  },
  // Unconditional — used for generation resets and gap resolves.
  replaceReconnectCursor: (seq: number) => {
    globalCursor = seq;
  },
  resetReconnectCursor: () => {
    globalCursor = null;
  },
}));

const publishMock = mock((_event: string, _payload: unknown) => {});
mock.module("@/lib/event-bus", () => ({
  publish: publishMock,
}));

const { anchorColdStartReplay } = await import("@/lib/streaming/cold-anchor");

// Read the mocked cursor through a typed accessor so control-flow analysis
// doesn't narrow the `let` binding to the value last assigned in the test
// (the mock mutates it opaquely via the module under test).
const readCursor = (): number | null => globalCursor;

describe("anchorColdStartReplay", () => {
  beforeEach(() => {
    globalCursor = null;
    publishMock.mockClear();
  });

  test("seeds the cursor at S and requests a re-anchor on a cold session", () => {
    // GIVEN the connection is cold (no live event has seeded the cursor yet)
    globalCursor = null;

    // WHEN /messages resolves with a snapshot watermark S
    anchorColdStartReplay(42);

    // THEN the resumable cursor is seeded at S
    expect(readCursor()).toBe(42);
    // AND a single re-anchor bounce is requested
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith("sse.anchor-requested", {});
  });

  test("is a no-op once a live event has already seeded the cursor", () => {
    // GIVEN a live event already advanced the cursor (the connection is no
    // longer cold)
    globalCursor = 100;

    // WHEN /messages resolves with an older snapshot watermark
    anchorColdStartReplay(42);

    // THEN the cursor is left untouched (no backwards re-anchor)
    expect(readCursor()).toBe(100);
    // AND no bounce is requested
    expect(publishMock).not.toHaveBeenCalled();
  });

  test("is a no-op when the snapshot reports no honest position", () => {
    // GIVEN the connection is cold
    globalCursor = null;

    // WHEN /messages resolves without a seq (e.g. an older daemon)
    anchorColdStartReplay(null);

    // THEN the cursor stays null (cursor-less cold connect, as today)
    expect(readCursor()).toBeNull();
    // AND no bounce is requested
    expect(publishMock).not.toHaveBeenCalled();
  });
});
