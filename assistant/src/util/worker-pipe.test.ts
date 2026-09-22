import { afterEach, describe, expect, test } from "bun:test";

import { writeWorkerLine } from "./worker-pipe.js";

const spawned: { kill(signal?: NodeJS.Signals): void }[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

describe("writeWorkerLine", () => {
  /**
   * The production failure: the payload outruns the pipe buffer, Bun hands
   * `write` and `flush` one pending promise, and the worker dies before
   * draining it. Bun rejects that promise from its own event loop, after this
   * call has returned. Unobserved, the rejection is an `unhandledRejection`,
   * which `bun test` reports as a failure of this test.
   */
  test("reports a write still pending when the worker dies", async () => {
    const failure = Promise.withResolvers<unknown>();
    const epipe = Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
    });
    const pending = Promise.withResolvers<number>();
    const stdin = {
      write: () => pending.promise,
      flush: () => pending.promise,
    };

    writeWorkerLine(stdin, "line", failure.resolve);
    pending.reject(epipe);

    expect(await failure.promise).toBe(epipe);
  });

  test("reports a synchronous throw", () => {
    const failures: unknown[] = [];
    const epipe = Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
    });
    const stdin = {
      write() {
        throw epipe;
      },
      flush: () => 0,
    };

    writeWorkerLine(stdin, "line", (err) => failures.push(err));

    expect(failures).toEqual([epipe]);
  });

  /** `write` and `flush` both report the same broken pipe. */
  test("reports one failure when write and flush both reject", async () => {
    const failures: unknown[] = [];
    const epipe = new Error("EPIPE: broken pipe, send");
    const stdin = {
      write: () => Promise.reject(epipe),
      flush: () => Promise.reject(epipe),
    };

    writeWorkerLine(stdin, "line", (err) => failures.push(err));
    await Bun.sleep(0);

    expect(failures).toEqual([epipe]);
  });

  test("stays silent when the line is delivered", async () => {
    const failures: unknown[] = [];
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", "process.stdin.on('data', () => {})"],
      windowsHide: true,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);

    writeWorkerLine(proc.stdin, "hello", (err) => failures.push(err));
    await Bun.sleep(50);

    expect(failures).toEqual([]);
  });
});
