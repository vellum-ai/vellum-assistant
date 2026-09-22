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
   * The contract this module rests on, against the real Bun API: a payload
   * that outruns the pipe buffer comes back as a `Promise`, and killing the
   * worker settles it. Which way it settles is Bun's to choose. It rejects
   * with EPIPE on nearly every kill and, rarely on Linux, resolves with a
   * short count instead, so this asserts only that nothing escapes either
   * way. Demanding the rejection is what made this case flaky on CI.
   */
  test("observes a real pending write however Bun settles it", async () => {
    const proc = spawnBusyWorker();
    const failures: unknown[] = [];
    const settling: Promise<number>[] = [];
    const record = (result: number | Promise<number>) => {
      if (result instanceof Promise) {
        settling.push(result);
      }
      return result;
    };

    writeWorkerLine(
      {
        write: (chunk) => record(proc.stdin.write(chunk)),
        flush: () => record(proc.stdin.flush()),
      },
      OVERSIZED_LINE,
      (err) => failures.push(err),
    );
    proc.kill("SIGKILL");
    const outcomes = await Promise.race([
      Promise.allSettled(settling),
      Bun.sleep(10_000).then(() => null),
    ]);

    expect(settling.length).toBeGreaterThan(0);
    expect(outcomes).not.toBeNull();
    expect(failures).toHaveLength(
      outcomes!.some((o) => o.status === "rejected") ? 1 : 0,
    );
  });

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
