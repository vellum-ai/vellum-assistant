import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { cliWrite } from "../util/logger.js";

/**
 * Regression coverage for the CLI logger writing to an output stream whose
 * reader is gone.
 *
 * The daemon is spawned detached with `stdio: ["ignore", "pipe", "pipe"]` and
 * the spawning parent pipes that stdout into a log file. When the parent
 * exits it takes the read end with it, so every later write to the daemon's
 * stdout fails with `EPIPE`. Under Bun that failure is not raised at the call
 * site: it is handed to the write completion callback, and with no callback it
 * escalates to an `uncaughtException`, which the daemon's fatal-error handler
 * turns into a full shutdown. A bare `try`/`catch` around the write does not
 * see it, so these tests exercise the callback path specifically.
 *
 * The stubs below invoke the completion callback synchronously so the
 * assertions stay deterministic; the code under test does not care whether the
 * callback is synchronous or deferred.
 */

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

/** Stream stub that reports `err` through the write completion callback. */
function callbackFailingStream(err: NodeJS.ErrnoException) {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string, callback: (e?: Error | null) => void): boolean {
      writes.push(chunk);
      callback(err);
      return false;
    },
  };
}

/** Stream stub that raises synchronously instead of using the callback. */
function throwingStream(err: NodeJS.ErrnoException) {
  return {
    write(): boolean {
      throw err;
    },
  };
}

/** Stream stub that records what was written and reports success. */
function recordingStream() {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string, callback: (e?: Error | null) => void): boolean {
      writes.push(chunk);
      callback(null);
      return true;
    },
  };
}

describe("cliWrite closed-output containment", () => {
  for (const code of [
    "EPIPE",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
  ]) {
    test(`drops the line when the write callback reports ${code}`, () => {
      const stream = callbackFailingStream(errnoError(code));
      const write = cliWrite(stream);

      expect(() => write("pinned extension tab")).not.toThrow();
      expect(stream.writes).toEqual(["pinned extension tab\n"]);
    });

    test(`contains a synchronously raised ${code}`, () => {
      const write = cliWrite(throwingStream(errnoError(code)));

      expect(() => write("pinned extension tab")).not.toThrow();
    });
  }

  test("keeps writing after the reader goes away", () => {
    // The daemon logs on every pin mutation, so containment has to hold for
    // the whole life of the process, not just the first failed write.
    const stream = callbackFailingStream(errnoError("EPIPE"));
    const write = cliWrite(stream);

    for (let i = 0; i < 25; i++) {
      expect(() => write(`line ${i}`)).not.toThrow();
    }
    expect(stream.writes).toHaveLength(25);
  });

  test("re-raises an unrelated failure reported to the callback", () => {
    const write = cliWrite(callbackFailingStream(errnoError("ENOSPC")));

    expect(() => write("disk full")).toThrow(/ENOSPC/);
  });

  test("re-raises an unrelated failure raised synchronously", () => {
    const write = cliWrite(throwingStream(errnoError("EACCES")));

    expect(() => write("denied")).toThrow(/EACCES/);
  });

  test("re-raises a failure carrying no errno code", () => {
    const write = cliWrite(throwingStream(new Error("programming error")));

    expect(() => write("boom")).toThrow(/programming error/);
  });

  test("survives a genuinely destroyed stream", async () => {
    // Belt to the stubs' suspenders: a real node stream, destroyed, reports
    // ERR_STREAM_DESTROYED through the same callback path.
    const stream = new PassThrough();
    stream.on("error", () => {});
    stream.destroy();
    const write = cliWrite(stream as unknown as Parameters<typeof cliWrite>[0]);

    expect(() => write("after destroy")).not.toThrow();
    // Let any deferred callback settle so an escaping raise would surface here
    // rather than after the test has passed.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("cliWrite message formatting", () => {
  test("writes a bare message", () => {
    const stream = recordingStream();
    cliWrite(stream)("hello");

    expect(stream.writes).toEqual(["hello\n"]);
  });

  test("discards the merge object and writes the message", () => {
    const stream = recordingStream();
    cliWrite(stream)({ conversationId: "conv-a", tabId: "42" }, "pinned tab");

    expect(stream.writes).toEqual(["pinned tab\n"]);
  });

  test("writes a bare newline when there is no message", () => {
    const stream = recordingStream();
    cliWrite(stream)({ conversationId: "conv-a" });

    expect(stream.writes).toEqual(["\n"]);
  });
});
