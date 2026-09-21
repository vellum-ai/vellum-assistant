import { afterEach, describe, expect, test } from "bun:test";

import { writeWorkerLine } from "./worker-pipe.js";

/** Comfortably larger than any OS pipe buffer, so the write cannot complete. */
const OVERSIZED_LINE = "x".repeat(4 * 1024 * 1024);

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

/** A live child that never reads stdin, the way a worker busy in ONNX does not. */
function spawnBusyWorker() {
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
    windowsHide: true,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  spawned.push(proc);
  return proc;
}

describe("writeWorkerLine", () => {
  /**
   * The production failure: the payload outruns the pipe buffer, Bun returns a
   * pending promise, and the worker dies before draining it. Unobserved, that
   * rejection is an `unhandledRejection`, which `bun test` reports as a failure
   * of this test.
   */
  test("reports a write still pending when the worker dies", async () => {
    const proc = spawnBusyWorker();
    const failure = Promise.withResolvers<unknown>();

    writeWorkerLine(proc.stdin, OVERSIZED_LINE, failure.resolve);
    proc.kill("SIGKILL");

    const err = await failure.promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("EPIPE");
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
