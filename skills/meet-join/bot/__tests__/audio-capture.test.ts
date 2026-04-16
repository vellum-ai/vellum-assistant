/**
 * Unit tests for the audio-capture pipeline.
 *
 * We never invoke real `parec` or open real Unix sockets here — the module
 * is designed around injected `spawn` / `connect` factories so the tests
 * can feed canned PCM through the chunker and inspect what lands on the
 * socket side. This keeps the suite fast and hermetic (runs on macOS CI
 * and containerless hosts alike).
 *
 * Coverage:
 *   - Happy path: PCM bytes from `parec` stdout are chunked into frames of
 *     the requested size and written to the socket in order.
 *   - Reconnect on parec exit: one failed spawn, second spawn succeeds.
 *   - Error surface after the retry budget is exhausted.
 *   - Non-default frame size honored.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FRAME_BYTES,
  DEFAULT_RATE_HZ,
  DEFAULT_SOURCE_DEVICE,
  type CapturedSocket,
  type SpawnedParec,
  startAudioCapture,
} from "../src/media/audio-capture.js";

/** -------------------- helpers --------------------------------------- */

/**
 * Build a `SpawnedParec` whose stdout emits the supplied `Uint8Array`
 * chunks synchronously (as separate `enqueue` calls) and then closes.
 * `exited` only settles once `kill()` is invoked — this prevents the
 * retry loop in `startAudioCapture` from firing spuriously as soon as the
 * stream drains.
 */
function fakeParec(chunks: Uint8Array[]): {
  proc: SpawnedParec;
  killed: Promise<void>;
} {
  let resolveExited!: (code: number) => void;
  let resolveKilled!: () => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const killed = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const proc: SpawnedParec = {
    stdout,
    exited,
    kill() {
      resolveExited(0);
      resolveKilled();
    },
  };
  return { proc, killed };
}

/**
 * `SpawnedParec` that exits with the supplied non-zero code immediately
 * (no stdout emitted). Used to exercise the reconnect / retry paths.
 */
function fakeFailedParec(exitCode: number): SpawnedParec {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return {
    stdout,
    exited: Promise.resolve(exitCode),
    kill() {
      /* already exited */
    },
  };
}

interface RecordingSocket extends CapturedSocket {
  /** All bytes written via `write()`, concatenated in order. */
  writes: Uint8Array[];
  /** Count of `end()` invocations. */
  endCalls: number;
  /** Count of `destroy()` invocations. */
  destroyCalls: number;
  /** Trigger a synthetic `error` event on this socket. */
  triggerError(err: NodeJS.ErrnoException): void;
  /** Trigger a synthetic `close` event on this socket. */
  triggerClose(): void;
}

/**
 * Build an in-memory socket shim that records every write and can be
 * signalled by the test to emit `error` / `close` events. This is the
 * substitute for the real Unix socket server on the daemon side.
 */
function recordingSocket(): RecordingSocket {
  const errorListeners: Array<(err: NodeJS.ErrnoException) => void> = [];
  const closeListeners: Array<() => void> = [];
  const writes: Uint8Array[] = [];
  let endCalls = 0;
  let destroyCalls = 0;

  return {
    writes,
    get endCalls() {
      return endCalls;
    },
    get destroyCalls() {
      return destroyCalls;
    },
    write(chunk: Uint8Array) {
      // Copy so later mutations by the test fixture can't retroactively
      // change what we've "received" on the wire.
      writes.push(new Uint8Array(chunk));
      return true;
    },
    end() {
      endCalls += 1;
    },
    destroy() {
      destroyCalls += 1;
    },
    on(event, listener) {
      if (event === "error") {
        errorListeners.push(listener as (err: NodeJS.ErrnoException) => void);
      } else {
        closeListeners.push(listener as () => void);
      }
    },
    triggerError(err: NodeJS.ErrnoException) {
      for (const l of errorListeners) l(err);
    },
    triggerClose() {
      for (const l of closeListeners) l();
    },
  };
}

/** Concatenate an array of Uint8Arrays into a single buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Build a deterministic fake PCM payload of the given size. */
function fakePcm(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // Cheap pattern: low byte is the index, so we can eyeball the contents
    // on test failure output.
    out[i] = i & 0xff;
  }
  return out;
}

async function tick(ms = 0): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Poll `predicate` until it returns true or the deadline elapses. Used to
 * wait for async side-effects (e.g. writes landing on the recording
 * socket) without relying on fixed sleeps.
 */
async function waitFor(
  predicate: () => boolean,
  {
    timeoutMs = 2000,
    intervalMs = 5,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(intervalMs);
  }
  throw new Error(`waitFor: predicate did not become true in ${timeoutMs}ms`);
}

/** -------------------- tests ----------------------------------------- */

describe("startAudioCapture — argv + defaults", () => {
  test("spawns parec with the expected flags and defaults", async () => {
    const spawnedArgv: string[][] = [];
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/test.sock",
      spawn: (argv) => {
        spawnedArgv.push([...argv]);
        return proc;
      },
      connect: () => sock,
    });

    expect(spawnedArgv.length).toBe(1);
    expect(spawnedArgv[0]).toEqual([
      "parec",
      `--device=${DEFAULT_SOURCE_DEVICE}`,
      "--format=s16le",
      `--rate=${DEFAULT_RATE_HZ}`,
      "--channels=1",
      "--raw",
    ]);

    await capture.stop();
  });

  test("honors custom sourceDevice + rateHz", async () => {
    const spawnedArgv: string[][] = [];
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/test.sock",
      sourceDevice: "custom_source.monitor",
      rateHz: 48_000,
      spawn: (argv) => {
        spawnedArgv.push([...argv]);
        return proc;
      },
      connect: () => sock,
    });

    expect(spawnedArgv[0]).toEqual([
      "parec",
      "--device=custom_source.monitor",
      "--format=s16le",
      "--rate=48000",
      "--channels=1",
      "--raw",
    ]);

    await capture.stop();
  });

  test("passes the socketPath verbatim to the connect factory", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();
    const seenPaths: string[] = [];

    const capture = await startAudioCapture({
      socketPath: "/var/run/meet/audio-xyz.sock",
      spawn: () => proc,
      connect: (path) => {
        seenPaths.push(path);
        return sock;
      },
    });

    expect(seenPaths).toEqual(["/var/run/meet/audio-xyz.sock"]);
    await capture.stop();
  });

  test("rejects a zero or negative frameBytes at start", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    let thrown: unknown;
    try {
      await startAudioCapture({
        socketPath: "/tmp/x.sock",
        frameBytes: 0,
        spawn: () => proc,
        connect: () => sock,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("frameBytes must be > 0");
  });
});

describe("startAudioCapture — framing", () => {
  test("chunks PCM into frames of the requested size, preserving byte order", async () => {
    // Use the production default (320 bytes). Feed 5 frames' worth (1600
    // bytes) split across 3 arbitrarily-sized chunks to prove the chunker
    // re-assembles them at frame boundaries.
    const frameBytes = DEFAULT_FRAME_BYTES;
    const total = frameBytes * 5;
    const payload = fakePcm(total);
    const split1 = payload.slice(0, 100); // smaller than one frame
    const split2 = payload.slice(100, 700); // crosses frame boundary
    const split3 = payload.slice(700); // remainder
    const { proc } = fakeParec([split1, split2, split3]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: () => proc,
      connect: () => sock,
    });

    // Wait until all 5 frames have arrived at the socket.
    await waitFor(() => sock.writes.length === 5);

    // Every write must be exactly `frameBytes` bytes.
    for (const w of sock.writes) {
      expect(w.length).toBe(frameBytes);
    }

    // Concatenated writes must equal the original payload verbatim.
    expect(concat(sock.writes)).toEqual(payload);

    await capture.stop();
  });

  test("drops an incomplete trailing partial frame at EOF", async () => {
    // 320-byte frames; send 321 bytes so exactly one full frame flushes and
    // the single-byte tail is held in the buffer until EOF, where the
    // implementation drops it rather than emitting a short frame.
    const frameBytes = 320;
    const payload = fakePcm(frameBytes + 1);
    const { proc } = fakeParec([payload]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      frameBytes,
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.writes.length === 1);
    // Give the pump a tick to confirm it doesn't emit another (short) frame
    // after the stream ends.
    await tick(20);
    expect(sock.writes.length).toBe(1);
    expect(sock.writes[0]!.length).toBe(frameBytes);

    await capture.stop();
  });

  test("supports non-default frame sizes", async () => {
    const frameBytes = 64;
    const payload = fakePcm(frameBytes * 3);
    const { proc } = fakeParec([payload]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      frameBytes,
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.writes.length === 3);
    for (const w of sock.writes) {
      expect(w.length).toBe(frameBytes);
    }
    expect(concat(sock.writes)).toEqual(payload);

    await capture.stop();
  });
});

describe("startAudioCapture — reconnect", () => {
  test("reconnects once after parec exits non-zero and resumes piping", async () => {
    // First spawn: parec exits with code 1 before emitting any data.
    const first = fakeFailedParec(1);
    // Second spawn: real canned payload.
    const payload = fakePcm(640); // two default-size frames
    const { proc: second } = fakeParec([payload]);

    const procs: SpawnedParec[] = [first, second];
    const spawnCalls: string[][] = [];
    let spawnIdx = 0;

    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: (argv) => {
        spawnCalls.push([...argv]);
        const p = procs[spawnIdx++];
        if (!p) throw new Error("spawn called more times than expected");
        return p;
      },
      connect: () => sock,
    });

    // Two frames should arrive after the reconnect.
    await waitFor(() => sock.writes.length === 2);
    expect(spawnCalls.length).toBe(2);
    expect(concat(sock.writes)).toEqual(payload);

    await capture.stop();
  });

  test("surfaces an error after 3 failed reconnects", async () => {
    // Every spawn returns a process that exits immediately with code 1.
    // Initial attempt + 3 reconnects = 4 spawns before we give up. `stop()`
    // must reject with an Error mentioning the retry exhaustion.
    let spawnCount = 0;
    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: () => {
        spawnCount += 1;
        return fakeFailedParec(1);
      },
      connect: () => recordingSocket(),
    });

    // Wait for the retry budget to be exhausted. 4 spawns * (~1ms per
    // attempt + 500ms backoff between attempts) — use a generous ceiling.
    await waitFor(() => spawnCount >= 4, { timeoutMs: 5000 });

    // Give the loop a moment to record the fatal error and signal done.
    await tick(50);

    let thrown: unknown;
    try {
      await capture.stop();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("parec exited with code 1");
    // Initial + 3 reconnects = 4 total spawns.
    expect(spawnCount).toBe(4);
  });

  test("onError callback fires after retry budget is exhausted", async () => {
    const errors: Error[] = [];
    let spawnCount = 0;
    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      onError: (err) => errors.push(err),
      spawn: () => {
        spawnCount += 1;
        return fakeFailedParec(2);
      },
      connect: () => recordingSocket(),
    });

    // Wait until the retry budget has been exhausted and the loop has
    // fired the callback. `stop()` early would suppress the fatal-error
    // path by short-circuiting the loop.
    await waitFor(() => errors.length === 1, { timeoutMs: 5000 });
    expect(spawnCount).toBe(4);
    expect(errors[0]!.message).toContain("parec exited with code 2");

    // stop() after the fact must still reject with the accumulated error.
    let thrown: unknown;
    try {
      await capture.stop();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("startAudioCapture — stop semantics", () => {
  test("stop() kills parec and closes the socket", async () => {
    const { proc, killed } = fakeParec([fakePcm(DEFAULT_FRAME_BYTES)]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.writes.length === 1);
    await capture.stop();

    // `stop()` must have killed the fake parec (it resolves `killed`).
    await killed;
    // And must have torn down the socket.
    expect(sock.endCalls).toBeGreaterThanOrEqual(1);
    expect(sock.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  test("stop() is idempotent", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: () => proc,
      connect: () => sock,
    });

    await capture.stop();
    // Second call should not hang or throw a duplicate error.
    await capture.stop();
  });

  test("socket error during capture triggers a reconnect", async () => {
    // First socket errors out; second is a plain recorder.
    const sock1 = recordingSocket();
    const sock2 = recordingSocket();
    let connectIdx = 0;

    const payload = fakePcm(DEFAULT_FRAME_BYTES);
    const { proc: proc1 } = fakeParec([]);
    const { proc: proc2 } = fakeParec([payload]);
    const procs = [proc1, proc2];
    let spawnIdx = 0;

    const capture = await startAudioCapture({
      socketPath: "/tmp/t.sock",
      spawn: () => procs[spawnIdx++]!,
      connect: () => (connectIdx++ === 0 ? sock1 : sock2),
    });

    // Simulate a socket error after the initial connect completes.
    await tick(10);
    const connErr = new Error("ECONNRESET") as NodeJS.ErrnoException;
    connErr.code = "ECONNRESET";
    sock1.triggerError(connErr);

    // Expect the second socket to eventually receive the replayed payload.
    await waitFor(() => sock2.writes.length === 1);
    expect(concat(sock2.writes)).toEqual(payload);

    await capture.stop();
  });
});
