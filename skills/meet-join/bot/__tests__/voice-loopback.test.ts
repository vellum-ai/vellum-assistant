/**
 * Voice loopback E2E test for the meet-bot.
 *
 * Boots the real bot HTTP server with a mocked `pacat` shim that captures
 * every byte written to its stdin into a single in-memory buffer. Then
 * drives the full speak path end-to-end:
 *
 *   1. POST a deterministic, recognizable PCM stream (sine-wave-shaped
 *      bytes) to `/play_audio` and assert the bytes that landed in the
 *      shim are byte-for-byte identical to what we sent — proving the
 *      pacat side of the bot/daemon contract is byte-perfect under
 *      streaming chunked upload, with no corruption in transit.
 *
 *   2. Open a separate POST whose body is gated so we can fire DELETE
 *      `/play_audio/:streamId` mid-stream. After the DELETE, assert that
 *      the shim sees no further input bytes (growth stops) and that the
 *      cancel path appends exactly 50ms of trailing silence (4800 zero
 *      bytes at 48 kHz mono s16le).
 *
 * The `pacat` shim is the same pattern as `audio-playback.test.ts`: it
 * exposes `SpawnedPacat` whose `stdin.write` appends into a `Uint8Array`
 * so tests can assert ordering. The bot's `createHttpServer` is wired
 * via `playbackSpawnOptions: { spawn: () => shim.proc }`, so no real
 * pacat process is involved.
 *
 * Why a "richer" loopback test alongside the PR 1 unit test:
 *   - The PR 1 test asserts the transport contract one assertion at a
 *     time. This test exercises the same pipeline against a non-trivial
 *     fixture (a recognizable byte pattern that any single-byte
 *     corruption would surface immediately) and treats the byte-perfect
 *     transit + cancel-with-trailing-silence invariant as the unit of
 *     validation. It is intentionally self-contained — no shared state
 *     with the PR 1 test, so removal of one does not regress the other.
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
  stopAudioPlayback,
  type PacatWritable,
  type SpawnedPacat,
} from "../src/media/audio-playback.js";

const API_TOKEN = "test-token-loopback";

/** Trailing-silence duration the bot writes after each /play_audio POST. */
const TRAILING_SILENCE_MS = 50;
/** Trailing-silence byte count at 48 kHz mono s16le. */
const TRAILING_SILENCE_BYTES = TRAILING_SILENCE_MS * DEFAULT_BYTES_PER_MS;

// ---------------------------------------------------------------------------
// Pacat shim — captures every byte ever written into a single buffer so
// tests can assert byte-perfect ordering and trailing silence.
// ---------------------------------------------------------------------------

interface PacatShim {
  proc: SpawnedPacat;
  /** All bytes written to pacat's stdin, in order. */
  readonly buffer: Uint8Array;
  /** How many bytes are in the shim right now. */
  size: () => number;
}

function makePacatShim(): PacatShim {
  let buf = new Uint8Array(0);
  let killed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const stdin: PacatWritable = {
    write(chunk: Uint8Array): number {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
      return chunk.length;
    },
    async end() {
      // Tests control lifetime explicitly via kill().
    },
  };

  const proc: SpawnedPacat = {
    stdin,
    exited,
    kill() {
      if (killed) return;
      killed = true;
      resolveExited(0);
    },
  };

  return {
    proc,
    get buffer() {
      return buf;
    },
    size: () => buf.length,
  };
}

// ---------------------------------------------------------------------------
// Fixture — build a recognizable PCM payload so single-byte corruption
// in transit would surface as a mismatch in the byte-by-byte comparison.
// We synthesize a discrete sine wave at the bot's native 48 kHz mono s16le
// format. The pattern is deterministic and non-trivial: any reorder, drop,
// duplication, or off-by-one in the pipeline would produce a mismatch.
// ---------------------------------------------------------------------------

function buildSinePcm(
  samples: number,
  frequencyHz: number,
): Uint8Array<ArrayBuffer> {
  // The explicit `Uint8Array<ArrayBuffer>` return type (rather than the
  // bare `Uint8Array`, which TS 5.9 widens to `Uint8Array<ArrayBufferLike>`)
  // is what lets the result satisfy fetch's `BodyInit` constraint under
  // strict NodeNext typing.
  const buffer = new ArrayBuffer(samples * 2); // s16le → 2 bytes/sample
  const view = new DataView(buffer);
  const sampleRate = 48_000;
  const amplitude = 0x4000; // half-scale int16 to leave headroom
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate),
    );
    view.setInt16(i * 2, value, /* littleEndian */ true);
  }
  return new Uint8Array(buffer);
}

/** Slice a buffer into chunks of `chunkSize` bytes for streaming. */
function chunkBytes(payload: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += chunkSize) {
    chunks.push(payload.subarray(off, Math.min(off + chunkSize, payload.length)));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice loopback E2E (bot HTTP → pacat shim)", () => {
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

  test("POST /play_audio delivers a recognizable PCM stream byte-perfectly to pacat, then 50ms of silence", async () => {
    server = build();
    const { port } = await server.start(0);

    // 480 samples = 960 bytes = 10ms of audio at 48 kHz mono s16le.
    // A 440 Hz sine is a recognizable pattern; corruption would change
    // the comparison at the first faulty byte.
    const payload = buildSinePcm(480, 440);
    expect(payload.length).toBe(960);

    const res = await fetch(
      `http://127.0.0.1:${port}/play_audio?stream_id=loopback-1`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/octet-stream",
        },
        body: payload,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { streamId: string; bytes: number };
    expect(body.streamId).toBe("loopback-1");
    expect(body.bytes).toBe(payload.length);

    // The shim must contain the original payload byte-for-byte, then
    // exactly TRAILING_SILENCE_BYTES of zeros appended by the bot's
    // post-stream silence flush.
    expect(shim.size()).toBe(payload.length + TRAILING_SILENCE_BYTES);

    // Byte-perfect match on the audio prefix.
    const audioSlice = shim.buffer.subarray(0, payload.length);
    expect(audioSlice.length).toBe(payload.length);
    expect(Array.from(audioSlice)).toEqual(Array.from(payload));

    // Trailing silence must be all zero.
    const silenceSlice = shim.buffer.subarray(payload.length);
    expect(silenceSlice.length).toBe(TRAILING_SILENCE_BYTES);
    for (const byte of silenceSlice) {
      expect(byte).toBe(0);
    }
  });

  test("DELETE mid-stream stops buffer growth and appends exactly 50ms of trailing silence", async () => {
    server = build();
    const { port } = await server.start(0);

    // First chunk is delivered immediately. The body's `start` then waits
    // on a gate so the rest of the payload is only released after the
    // test fires DELETE — guaranteeing the cancel lands while bytes are
    // still in flight.
    const firstChunk = buildSinePcm(240, 440); // 240 samples = 480 bytes
    expect(firstChunk.length).toBe(480);
    const remainingChunks: Uint8Array[] = chunkBytes(
      buildSinePcm(2400, 880), // 2400 samples = 4800 bytes
      512,
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(firstChunk);
        // Park here until the test DELETEs and releases us.
        await gate;
        try {
          for (const chunk of remainingChunks) {
            controller.enqueue(chunk);
          }
        } catch {
          // Reader cancelled — expected when DELETE has already aborted.
        }
        controller.close();
      },
    });

    const postPromise = fetch(
      `http://127.0.0.1:${port}/play_audio?stream_id=loopback-cancel`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/octet-stream",
        },
        body,
        // @ts-expect-error — undici/fetch extension, not in lib.dom types
        duplex: "half",
      },
    );

    // Give the bot a beat to ingest the first chunk so the shim has
    // recorded *some* audio bytes before we cancel. Without this the
    // server might receive the DELETE before any bytes have been written
    // and the partial-vs-silence assertion below would be ambiguous.
    await new Promise((r) => setTimeout(r, 50));
    const sizeBeforeDelete = shim.size();
    expect(sizeBeforeDelete).toBeGreaterThan(0);
    expect(sizeBeforeDelete).toBeLessThanOrEqual(firstChunk.length);

    // Fire DELETE — the bot aborts the in-flight POST and schedules the
    // trailing silence flush in the POST handler's `finally`.
    const delRes = await fetch(
      `http://127.0.0.1:${port}/play_audio/loopback-cancel`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as {
      cancelled: boolean;
      streamId: string;
    };
    expect(delBody.cancelled).toBe(true);
    expect(delBody.streamId).toBe("loopback-cancel");

    // Release the gate so the body's `start` coroutine completes — the
    // server's reader has already been cancelled, so the remaining
    // chunks are dropped on the floor (this is what we want to verify
    // below: no further audio bytes land in the shim).
    release();

    const postRes = await postPromise;
    expect(postRes.status).toBe(499);
    const payload = (await postRes.json()) as {
      streamId: string;
      bytes: number;
      cancelled: boolean;
    };
    expect(payload.streamId).toBe("loopback-cancel");
    expect(payload.cancelled).toBe(true);

    // -------- Buffer growth stops after the cancel --------
    //
    // The bot's POST handler must have written *only* the partial audio
    // it already had (≤ firstChunk.length) plus exactly the trailing
    // silence block. Anything more would mean post-cancel bytes leaked
    // through.
    const finalSize = shim.size();
    const audioBytesWritten = payload.bytes;
    expect(audioBytesWritten).toBeLessThanOrEqual(firstChunk.length);
    expect(finalSize).toBe(audioBytesWritten + TRAILING_SILENCE_BYTES);

    // The trailing TRAILING_SILENCE_BYTES bytes must all be zero.
    const trailing = shim.buffer.subarray(
      finalSize - TRAILING_SILENCE_BYTES,
      finalSize,
    );
    expect(trailing.length).toBe(TRAILING_SILENCE_BYTES);
    for (const byte of trailing) {
      expect(byte).toBe(0);
    }

    // The audio prefix must match the corresponding prefix of the first
    // chunk byte-for-byte. (No reorder / duplication / corruption.)
    const audioPrefix = shim.buffer.subarray(0, audioBytesWritten);
    expect(Array.from(audioPrefix)).toEqual(
      Array.from(firstChunk.subarray(0, audioBytesWritten)),
    );
  });
});
