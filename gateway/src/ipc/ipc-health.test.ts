import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture log calls so we can assert on the edge-triggered down/up lines.
const warnCalls: Array<{ obj: unknown; msg: string }> = [];
const infoCalls: Array<{ obj: unknown; msg: string }> = [];

mock.module("../logger.js", () => ({
  getLogger: () => ({
    warn: (obj: unknown, msg: string) => warnCalls.push({ obj, msg }),
    info: (obj: unknown, msg: string) => infoCalls.push({ obj, msg }),
    error: () => {},
    debug: () => {},
  }),
  initLogger: () => {},
}));

const { noteIpcReachable, noteIpcTransportError, __resetIpcHealthForTests } =
  await import("./ipc-health.js");
const { IpcHandlerError, IpcTransportError } =
  await import("./assistant-client.js");

describe("ipc-health", () => {
  beforeEach(() => {
    warnCalls.length = 0;
    infoCalls.length = 0;
    __resetIpcHealthForTests();
  });

  afterEach(() => {
    __resetIpcHealthForTests();
  });

  test("logs a single down line across many transport errors", () => {
    const err = new IpcTransportError("Call timed out after 30000ms");

    // First error => one WARN, caller told to stay silent.
    expect(noteIpcTransportError(err, "outbound-voice-verification-sync")).toBe(true);
    // Many subsequent errors => no further logs, still silent.
    for (let i = 0; i < 10; i++) {
      expect(noteIpcTransportError(err, "outbound-voice-verification-sync")).toBe(true);
    }

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].msg).toBe(
      "Assistant IPC is down — suppressing repeat sync errors until it recovers",
    );
  });

  test("a single recovery logs one back line with the suppressed count", () => {
    const err = new IpcTransportError("Call timed out after 30000ms");
    noteIpcTransportError(err); // down (logged)
    noteIpcTransportError(err); // suppressed
    noteIpcTransportError(err); // suppressed

    noteIpcReachable();

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0].msg).toBe("Assistant IPC is back");
    expect(
      (infoCalls[0].obj as { suppressedErrors: number }).suppressedErrors,
    ).toBe(2);
  });

  test("noteIpcReachable is a no-op while already healthy", () => {
    noteIpcReachable();
    noteIpcReachable();
    expect(infoCalls).toHaveLength(0);
  });

  test("recovers and can go down again, logging each edge once", () => {
    const err = new IpcTransportError("boom");

    noteIpcTransportError(err);
    noteIpcReachable();
    noteIpcTransportError(err);
    noteIpcReachable();

    expect(warnCalls).toHaveLength(2);
    expect(infoCalls).toHaveLength(2);
  });

  test("down/up state is shared across callers (single signal)", () => {
    const err = new IpcTransportError("boom");

    // Loop A goes down (logs), Loop B sees it already down (silent).
    expect(noteIpcTransportError(err, "sync-loop-a")).toBe(true);
    expect(noteIpcTransportError(err, "sync-loop-b")).toBe(true);
    expect(warnCalls).toHaveLength(1);

    // Either loop recovering clears the shared state once.
    noteIpcReachable();
    expect(infoCalls).toHaveLength(1);
  });

  test("non-transport errors are not owned by the tracker", () => {
    const handlerErr = new IpcHandlerError("nope", 404, "NOT_FOUND");
    expect(noteIpcTransportError(handlerErr)).toBe(false);

    const domainErr = new Error("upsert failed");
    expect(noteIpcTransportError(domainErr)).toBe(false);

    // No state change, so no recovery line either.
    noteIpcReachable();
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(0);
  });
});
