/**
 * Unit tests for the audio-playback pipeline.
 *
 * We don't spawn a real `pacat` — the module accepts an injected `spawn`
 * factory whose `stdin` is a shim that appends writes to a `Uint8Array`
 * buffer. That lets us assert byte ordering on completion, mid-stream
 * cancellation, and the trailing silence flush without any OS processes.
 *
 * Coverage:
 *   - Module: `startAudioPlayback` spawns with the expected argv and is
 *     idempotent (second call returns the same handle).
 *   - Module: `stopAudioPlayback` kills pacat and clears the singleton.
 *   - Module: `flushSilence` writes the correct number of zero bytes.
 *   - HTTP: POST /play_audio forwards body bytes in order and flushes
 *     trailing silence on completion.
 *   - HTTP: POST /play_audio with an abort-triggered stream returns 499
 *     and stops writing bytes to the shim mid-stream.
 *   - HTTP: DELETE /play_audio/:streamId cancels the matching POST.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createHttpServer, type HttpServerHandle } from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";
import {
  DEFAULT_BYTES_PER_MS,
  __resetForTests,
  flushSilence,
  startAudioPlayback,
  stopAudioPlayback,
  type PacatWritable,
  type SpawnedPacat,
} from "../src/media/audio-playback.js";

const API_TOKEN = "test-token-playback";

/** ------------------------ shim helpers ---------------------------- */

interface PacatShim {
  proc: SpawnedPacat;
  /** All bytes written to pacat's stdin, in order. */
  readonly buffer: Uint8Array;
  /** Resolves once `kill()` is called. */
  killed: Promise<void>;
  /** Was kill() invoked? */
  isKilled: () => boolean;
  /** How many `write` calls have been made so far. */
  writeCount: () => number;
}

/**
 * Build a fake pacat whose stdin appends every write into a single
 * `Uint8Array` so tests can assert end-to-end byte ordering. The process
 * stays alive until `kill()` is invoked (matching how real pacat behaves
 * until we SIGTERM it).
 */
function makePacatShim(): PacatShim {
  let buf = new Uint8Array(0);
  let writes = 0;
  let killed = false;
  let resolveExited!: (code: number) => void;
  let resolveKilled!: () => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const killedP = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });

  const stdin: PacatWritable = {
    write(chunk: Uint8Array): number {
      writes += 1;
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
      return chunk.length;
    },
    async end() {
      // No-op; the test controls lifetime via kill().
    },
  };

  const proc: SpawnedPacat = {
    stdin,
    exited,
    kill() {
      if (killed) return;
      killed = true;
      resolveKilled();
      resolveExited(0);
    },
  };

  const shim: PacatShim = {
    proc,
    get buffer() {
      return buf;
    },
    killed: killedP,
    isKilled: () => killed,
    writeCount: () => writes,
  };
  return shim;
}

/** ---------------------- module-level tests ----------------------- */

describe("audio-playback module", () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(async () => {
    await stopAudioPlayback();
    __resetForTests();
  });

  test("startAudioPlayback spawns pacat with the expected argv", () => {
    let capturedArgv: readonly string[] | null = null;
    const shim = makePacatShim();
    const handle = startAudioPlayback({
      spawn: (argv) => {
        capturedArgv = argv;
        return shim.proc;
      },
    });
    expect(capturedArgv).not.toBeNull();
    expect(capturedArgv as readonly string[] | null).toEqual([
      "pacat",
      "--playback",
      "--device=bot_out",
      "--format=s16le",
      "--rate=48000",
      "--channels=1",
      "--raw",
    ]);
    expect(handle.active).toBe(true);
  });

  test("startAudioPlayback is idempotent — second call returns the same handle", () => {
    const shim = makePacatShim();
    let spawns = 0;
    const h1 = startAudioPlayback({
      spawn: () => {
        spawns += 1;
        return shim.proc;
      },
    });
    const h2 = startAudioPlayback({
      spawn: () => {
        spawns += 1;
        return shim.proc;
      },
    });
    expect(h1).toBe(h2);
    expect(spawns).toBe(1);
  });

  test("stopAudioPlayback kills pacat and clears the singleton", async () => {
    const shim = makePacatShim();
    startAudioPlayback({ spawn: () => shim.proc });
    await stopAudioPlayback();
    expect(shim.isKilled()).toBe(true);
    // After stop, a fresh start should spawn again.
    const shim2 = makePacatShim();
    let spawned = false;
    startAudioPlayback({
      spawn: () => {
        spawned = true;
        return shim2.proc;
      },
    });
    expect(spawned).toBe(true);
  });

  test("flushSilence writes ms * bytesPerMs zero bytes", async () => {
    const shim = makePacatShim();
    startAudioPlayback({ spawn: () => shim.proc });
    await flushSilence(10); // 10ms at 48kHz mono s16le = 960 bytes
    expect(shim.buffer.length).toBe(10 * DEFAULT_BYTES_PER_MS);
    // All bytes must be zero.
    for (const b of shim.buffer) {
      expect(b).toBe(0);
    }
  });

  test("flushSilence on inactive handle is a no-op", async () => {
    await flushSilence(10); // no active handle
    // No throw = pass.
  });
});

/** ---------------------- HTTP endpoint tests ----------------------- */

describe("POST /play_audio (streaming)", () => {
  let server: HttpServerHandle | null = null;
  let shim: PacatShim;

  beforeEach(() => {
    __resetForTests();
    BotState.__resetForTests();
    shim = makePacatShim();
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
    await stopAudioPlayback();
    __resetForTests();
  });

  function build(): HttpServerHandle {
    return createHttpServer({
      apiToken: API_TOKEN,
      onLeave: () => {},
      onSendChat: () => {},
      onPlayAudio: () => {},
      playbackSpawnOptions: { spawn: () => shim.proc },
    });
  }

  test("forwards PCM bytes in order and flushes trailing silence", async () => {
    server = build();
    const { port } = await server.start(0);

    // Build a deterministic PCM payload: four 4-byte chunks.
    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10, 11, 12]),
      new Uint8Array([13, 14, 15, 16]),
    ];
    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const flat = new Uint8Array(totalLen);
    let o = 0;
    for (const c of chunks) {
      flat.set(c, o);
      o += c.length;
    }

    const res = await fetch(`http://127.0.0.1:${port}/play_audio?stream_id=s-1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: flat,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streamId: string; bytes: number };
    expect(body.streamId).toBe("s-1");
    expect(body.bytes).toBe(totalLen);

    // The shim should have received the original bytes in order, followed
    // by 50ms of trailing silence (50 * 96 = 4800 zero bytes).
    const expectedSilenceBytes = 50 * DEFAULT_BYTES_PER_MS;
    expect(shim.buffer.length).toBe(totalLen + expectedSilenceBytes);
    for (let i = 0; i < totalLen; i++) {
      expect(shim.buffer[i]).toBe(flat[i]!);
    }
    for (let i = totalLen; i < shim.buffer.length; i++) {
      expect(shim.buffer[i]).toBe(0);
    }
  });

  test("DELETE /play_audio/:streamId cancels in-flight stream with 499", async () => {
    // For this test we want a payload large enough that we can DELETE it
    // before it finishes. We feed the body through a ReadableStream with
    // a gate so the last chunk is only released after the DELETE runs.
    server = build();
    const { port } = await server.start(0);

    const firstChunk = new Uint8Array(1024);
    for (let i = 0; i < firstChunk.length; i++) firstChunk[i] = (i % 250) + 1;
    const secondChunk = new Uint8Array(1024);
    for (let i = 0; i < secondChunk.length; i++)
      secondChunk[i] = ((i + 17) % 250) + 1;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(firstChunk);
        // Wait until we've been told to release — the test triggers this
        // after issuing DELETE so the abort lands mid-stream.
        await gate;
        try {
          controller.enqueue(secondChunk);
        } catch {
          // enqueue may throw if the reader was cancelled; that's what we
          // want.
        }
        controller.close();
      },
    });

    const postPromise = fetch(
      `http://127.0.0.1:${port}/play_audio?stream_id=cancel-me`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/octet-stream",
        },
        // Bun/undici fetch supports passing a ReadableStream as body when
        // `duplex: "half"` is set.
        body,
        // @ts-expect-error — undici/fetch extension, not in lib.dom types
        duplex: "half",
      },
    );

    // Give the server a beat to start writing the first chunk.
    await new Promise((r) => setTimeout(r, 50));

    // Cancel via DELETE — this should release the stream and make POST
    // return 499.
    const delRes = await fetch(
      `http://127.0.0.1:${port}/play_audio/cancel-me`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      },
    );
    expect(delRes.status).toBe(200);

    // Release the gate so the body's async start can complete — this
    // unsticks the ReadableStream's `start` coroutine. The server has
    // already aborted the reader by now so the second chunk is a no-op.
    release();

    const res = await postPromise;
    expect(res.status).toBe(499);
    const payload = (await res.json()) as {
      streamId: string;
      bytes: number;
      cancelled: boolean;
    };
    expect(payload.streamId).toBe("cancel-me");
    expect(payload.cancelled).toBe(true);
    // We should have written *at most* the first chunk (possibly less if
    // the server aborted mid-chunk write, but never the second).
    expect(payload.bytes).toBeLessThan(firstChunk.length + secondChunk.length);

    // Shim received at least the trailing silence block even on cancel.
    const silenceBytes = 50 * DEFAULT_BYTES_PER_MS;
    expect(shim.buffer.length).toBeGreaterThanOrEqual(silenceBytes);
  });

  test("empty body still returns 200 and flushes silence", async () => {
    server = build();
    const { port } = await server.start(0);

    const res = await fetch(`http://127.0.0.1:${port}/play_audio`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streamId: string; bytes: number };
    expect(body.bytes).toBe(0);
    expect(typeof body.streamId).toBe("string");
    expect(body.streamId.length).toBeGreaterThan(0);

    const silenceBytes = 50 * DEFAULT_BYTES_PER_MS;
    expect(shim.buffer.length).toBe(silenceBytes);
  });

  test("DELETE returns 404 when no matching stream is in flight", async () => {
    server = build();
    const { port } = await server.start(0);

    const res = await fetch(`http://127.0.0.1:${port}/play_audio/nonexistent`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
