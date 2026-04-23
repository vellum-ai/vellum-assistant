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
  /**
   * Writes excluding `AUTH <token>\n` handshake frames. Framing and
   * chunking assertions should use this so they don't trip on the
   * handshake the capture pipeline prepends to every attempt.
   */
  pcmWrites: Uint8Array[];
  /** Handshake frames — one per successful reconnect attempt. */
  authWrites: Uint8Array[];
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
 * Detect an `AUTH <token>\n` handshake frame by its ASCII prefix and
 * trailing newline. Intentionally loose on token content so rotating
 * the fixture token doesn't require matching the exact value here.
 */
function isAuthFrame(w: Uint8Array): boolean {
  if (w.length < 6) return false;
  // "AUTH "
  if (
    w[0] !== 0x41 ||
    w[1] !== 0x55 ||
    w[2] !== 0x54 ||
    w[3] !== 0x48 ||
    w[4] !== 0x20
  ) {
    return false;
  }
  return w[w.length - 1] === 0x0a;
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
    // The capture pipeline precedes every PCM stream with an
    // `AUTH <token>\n` handshake, and it re-sends the handshake on
    // every reconnect. Identify handshake writes by their `AUTH ` ASCII
    // prefix + trailing newline so tests that share a single
    // RecordingSocket across reconnect attempts still isolate PCM
    // frames cleanly.
    get pcmWrites() {
      return writes.filter((w) => !isAuthFrame(w));
    },
    get authWrites() {
      return writes.filter((w) => isAuthFrame(w));
    },
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
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

  test("passes daemonHost and daemonPort verbatim to the connect factory", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();
    const seenTargets: Array<{ host: string; port: number }> = [];

    const capture = await startAudioCapture({
      daemonHost: "host.docker.internal",
      daemonPort: 42173,
      authToken: "test-token",
      spawn: () => proc,
      connect: (host, port) => {
        seenTargets.push({ host, port });
        return sock;
      },
    });

    expect(seenTargets).toEqual([
      { host: "host.docker.internal", port: 42173 },
    ]);
    await capture.stop();
  });

  test("rejects a zero or negative frameBytes at start", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    let thrown: unknown;
    try {
      await startAudioCapture({
        daemonHost: "127.0.0.1",
        daemonPort: 9000,
      authToken: "test-token",
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

describe("startAudioCapture — auth handshake", () => {
  test("writes `AUTH <authToken>\\n` as the first bytes on every connection", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "tok-abc123",
      spawn: () => proc,
      connect: () => sock,
    });

    // The handshake is written synchronously at connect time — no wait
    // needed. It must be the very first write, ahead of any PCM frame.
    expect(sock.writes.length).toBeGreaterThanOrEqual(1);
    const first = sock.writes[0]!;
    const decoded = new TextDecoder().decode(first);
    expect(decoded).toBe("AUTH tok-abc123\n");

    await capture.stop();
  });

  test("resends the handshake after a reconnect", async () => {
    // First attempt: parec fails and we reconnect.
    const first = fakeFailedParec(1);
    const { proc: second } = fakeParec([fakePcm(DEFAULT_FRAME_BYTES)]);
    const procs = [first, second];
    let spawnIdx = 0;
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "tok-reconnect",
      spawn: () => procs[spawnIdx++]!,
      connect: () => sock,
    });

    await waitFor(() => sock.pcmWrites.length === 1);
    // Two auth writes (one per attempt): initial attempt + reconnect.
    expect(sock.authWrites.length).toBe(2);
    for (const frame of sock.authWrites) {
      expect(new TextDecoder().decode(frame)).toBe("AUTH tok-reconnect\n");
    }

    await capture.stop();
  });

  test("rejects an empty authToken up front", async () => {
    const { proc } = fakeParec([]);
    const sock = recordingSocket();

    let thrown: unknown;
    try {
      await startAudioCapture({
        daemonHost: "127.0.0.1",
        daemonPort: 9000,
        authToken: "",
        spawn: () => proc,
        connect: () => sock,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("authToken is required");
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      spawn: () => proc,
      connect: () => sock,
    });

    // Wait until all 5 PCM frames have arrived at the socket (excluding
    // the auth handshake that precedes them).
    await waitFor(() => sock.pcmWrites.length === 5);

    // Every PCM write must be exactly `frameBytes` bytes.
    for (const w of sock.pcmWrites) {
      expect(w.length).toBe(frameBytes);
    }

    // Concatenated PCM writes must equal the original payload verbatim.
    expect(concat(sock.pcmWrites)).toEqual(payload);

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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      frameBytes,
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.pcmWrites.length === 1);
    // Give the pump a tick to confirm it doesn't emit another (short) frame
    // after the stream ends.
    await tick(20);
    expect(sock.pcmWrites.length).toBe(1);
    expect(sock.pcmWrites[0]!.length).toBe(frameBytes);

    await capture.stop();
  });

  test("supports non-default frame sizes", async () => {
    const frameBytes = 64;
    const payload = fakePcm(frameBytes * 3);
    const { proc } = fakeParec([payload]);
    const sock = recordingSocket();

    const capture = await startAudioCapture({
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      frameBytes,
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.pcmWrites.length === 3);
    for (const w of sock.pcmWrites) {
      expect(w.length).toBe(frameBytes);
    }
    expect(concat(sock.pcmWrites)).toEqual(payload);

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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      spawn: (argv) => {
        spawnCalls.push([...argv]);
        const p = procs[spawnIdx++];
        if (!p) throw new Error("spawn called more times than expected");
        return p;
      },
      connect: () => sock,
    });

    // Two frames should arrive after the reconnect. Each reconnect
    // resends the handshake, so `writes` starts with the second
    // attempt's auth frame; filter it out via `pcmWrites`.
    await waitFor(() => sock.pcmWrites.length === 2);
    expect(spawnCalls.length).toBe(2);
    expect(concat(sock.pcmWrites)).toEqual(payload);

    await capture.stop();
  });

  test("surfaces an error after 3 failed reconnects", async () => {
    // Every spawn returns a process that exits immediately with code 1.
    // Initial attempt + 3 reconnects = 4 spawns before we give up. `stop()`
    // must reject with an Error mentioning the retry exhaustion.
    let spawnCount = 0;
    const capture = await startAudioCapture({
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      spawn: () => proc,
      connect: () => sock,
    });

    await waitFor(() => sock.pcmWrites.length === 1);
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
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
      daemonHost: "127.0.0.1",
      daemonPort: 9000,
      authToken: "test-token",
      spawn: () => procs[spawnIdx++]!,
      connect: () => (connectIdx++ === 0 ? sock1 : sock2),
    });

    // Simulate a socket error after the initial connect completes.
    await tick(10);
    const connErr = new Error("ECONNRESET") as NodeJS.ErrnoException;
    connErr.code = "ECONNRESET";
    sock1.triggerError(connErr);

    // Expect the second socket to eventually receive the replayed payload.
    await waitFor(() => sock2.pcmWrites.length === 1);
    expect(concat(sock2.pcmWrites)).toEqual(payload);

    await capture.stop();
  });
});
