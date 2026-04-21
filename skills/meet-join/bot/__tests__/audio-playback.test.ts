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

import {
  createHttpServer,
  type HttpServerHandle,
} from "../src/control/http-server.js";
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

  test("resetPlaybackClock rewinds the utterance-relative clock back to 0 so the next write starts from 0 again", async () => {
    const shim = makePacatShim();
    const handle = startAudioPlayback({ spawn: () => shim.proc });

    const observed: number[] = [];
    handle.onPlaybackTimestamp((ts) => {
      observed.push(ts);
    });

    // Utterance 1: 10ms of audio. At 48kHz mono s16le that's
    // 10 * 96 = 960 bytes; the handle should emit ts = 10ms.
    await handle.write(new Uint8Array(10 * DEFAULT_BYTES_PER_MS));
    expect(observed).toEqual([10]);

    // Reset the clock — simulates the HTTP server at the start of a
    // second POST /play_audio. No emission; the clock is silently
    // rewound to 0.
    handle.resetPlaybackClock();
    expect(observed).toEqual([10]);

    // Utterance 2: 5ms of audio. Without the reset the next emission
    // would have been 15ms (10 + 5). With the reset the handle must
    // emit ts = 5ms — the start of the new utterance's coordinate
    // system, matching how the daemon stamps VisemeEvent.timestamp.
    await handle.write(new Uint8Array(5 * DEFAULT_BYTES_PER_MS));
    expect(observed).toEqual([10, 5]);
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

    const res = await fetch(
      `http://127.0.0.1:${port}/play_audio?stream_id=s-1`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/octet-stream",
        },
        body: flat,
      },
    );
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

  test("concurrent POSTs with different streamIds serialize — second pre-empts first, bytes never interleave", async () => {
    // Regression guard: the bot only owns a single shared pacat stdin (the
    // audio-playback module-level singleton), so two concurrent POSTs with
    // *different* streamIds must not race on `handle.write()`. A fresh POST
    // must abort whatever is currently in flight, wait for its trailing-
    // silence flush to land, and only then begin writing its own bytes.
    server = build();
    const { port } = await server.start(0);

    // Distinct byte patterns so any interleaving would surface as a visible
    // mixing of pattern-A bytes into the pattern-B region of the shim.
    const chunkA1 = new Uint8Array(512).fill(0xaa);
    const chunkA2 = new Uint8Array(512).fill(0xbb);
    const chunkA3 = new Uint8Array(512).fill(0xcc);
    const payloadB = new Uint8Array(1024).fill(0x42);

    // Gate the A body so the first chunk delivers immediately but the rest
    // is withheld until the test releases it — this keeps A "in flight"
    // long enough for us to issue B concurrently.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bodyA = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(chunkA1);
        await gateA;
        try {
          controller.enqueue(chunkA2);
          controller.enqueue(chunkA3);
        } catch {
          // Reader cancelled — expected once B's POST aborts us.
        }
        controller.close();
      },
    });

    const postA = fetch(`http://127.0.0.1:${port}/play_audio?stream_id=a`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: bodyA,
      // @ts-expect-error — undici/fetch extension, not in lib.dom types
      duplex: "half",
    });

    // Let A get a foothold — it must have registered in activeStreams and
    // written at least its first chunk before we fire B, otherwise B would
    // see an empty registry and not need to pre-empt anything.
    await new Promise((r) => setTimeout(r, 50));

    // Second POST with a different streamId and a complete body. This
    // should abort A, wait for A's finally/silence-flush to land, then
    // write payloadB to the shim uninterrupted.
    const postB = fetch(`http://127.0.0.1:${port}/play_audio?stream_id=b`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: payloadB,
    });

    // Give B's POST handler time to hit the server and run its abort step
    // (step 1 in the serialization logic in http-server.ts) before we
    // release A's gate. Without this wait, `releaseA()` would unblock A's
    // body coroutine immediately — before B's abort lands — and A would
    // complete normally, leaving nothing for B to pre-empt.
    await new Promise((r) => setTimeout(r, 50));

    // Release A's gate so A's body coroutine can finish (the bot's reader
    // has already been cancelled at this point, so the later chunks are
    // dropped on the floor — this is the whole point of the test).
    releaseA();

    const [resA, resB] = await Promise.all([postA, postB]);

    // -------- A was cancelled mid-stream --------
    expect(resA.status).toBe(499);
    const bodyAJson = (await resA.json()) as {
      streamId: string;
      bytes: number;
      cancelled: boolean;
    };
    expect(bodyAJson.streamId).toBe("a");
    expect(bodyAJson.cancelled).toBe(true);
    // A must not have delivered its full payload (cancelled before the
    // gate-released chunks could be written).
    const fullAPayload = chunkA1.length + chunkA2.length + chunkA3.length;
    expect(bodyAJson.bytes).toBeLessThan(fullAPayload);

    // -------- B completed cleanly with its full payload --------
    expect(resB.status).toBe(200);
    const bodyBJson = (await resB.json()) as {
      streamId: string;
      bytes: number;
    };
    expect(bodyBJson.streamId).toBe("b");
    expect(bodyBJson.bytes).toBe(payloadB.length);

    // -------- Shim byte layout: A partial + silence + B full + silence --------
    //
    // Under the old (broken) code both handlers wrote to the shared pacat
    // stdin concurrently, which would leave pattern-A bytes (0xaa/0xbb/0xcc)
    // mixed into payloadB's region of the buffer. With the fix, the buffer
    // must be strictly sequential:
    //   [ A-partial (≤ fullAPayload bytes of 0xaa/0xbb/0xcc) ]
    //   [ TRAILING_SILENCE (50ms of zeros) ]
    //   [ B-full (payloadB.length bytes of 0x42) ]
    //   [ TRAILING_SILENCE (50ms of zeros) ]
    const silenceBytes = 50 * DEFAULT_BYTES_PER_MS;
    const expectedTotal =
      bodyAJson.bytes + silenceBytes + payloadB.length + silenceBytes;
    expect(shim.buffer.length).toBe(expectedTotal);

    // A's partial prefix: only 0xaa, 0xbb, or 0xcc bytes allowed.
    for (let i = 0; i < bodyAJson.bytes; i++) {
      const byte = shim.buffer[i]!;
      expect(byte === 0xaa || byte === 0xbb || byte === 0xcc).toBe(true);
    }
    // A's trailing silence: all zeros.
    for (let i = bodyAJson.bytes; i < bodyAJson.bytes + silenceBytes; i++) {
      expect(shim.buffer[i]).toBe(0);
    }
    // B's payload region: *must* be exclusively 0x42 — any pattern-A byte
    // here would be the interleaving regression this test is guarding.
    const bStart = bodyAJson.bytes + silenceBytes;
    const bEnd = bStart + payloadB.length;
    for (let i = bStart; i < bEnd; i++) {
      expect(shim.buffer[i]).toBe(0x42);
    }
    // B's trailing silence: all zeros.
    for (let i = bEnd; i < expectedTotal; i++) {
      expect(shim.buffer[i]).toBe(0);
    }
  });
});
