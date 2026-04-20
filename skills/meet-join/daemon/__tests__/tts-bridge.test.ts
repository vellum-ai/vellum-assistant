/**
 * Unit tests for {@link MeetTtsBridge}.
 *
 * These tests exercise the bridge without touching the real TTS registry,
 * the real ffmpeg binary, or a real bot container. Instead:
 *
 *   - The TTS provider is a canned implementation of {@link TtsProvider}
 *     whose `synthesizeStream` emits a fixed PCM byte sequence synchronously
 *     to the supplied `onChunk` callback.
 *   - `spawn` is mocked to return an in-memory stand-in for the ffmpeg
 *     child. The stand-in's stdout is a {@link PassThrough} — whatever the
 *     test pushes into it is what fetch will read as the HTTP request body.
 *     For the happy path we wire stdin → stdout as a pass-through so the
 *     bridge's provider-chunk → stdin → stdout pipeline works end-to-end.
 *   - A throwaway `Bun.serve` HTTP server plays the role of the bot
 *     container's `/play_audio` endpoint. It reads the chunked request
 *     body into memory and exposes it alongside any DELETE requests it
 *     received so the test can assert both happy-path and cancel-path
 *     traffic.
 *
 * What each test covers:
 *
 *   1. "bytes land at the bot unchanged" — provider emits a known PCM
 *      payload; assert the bot HTTP server received exactly those bytes
 *      on the POST body (with the right URL, headers, and content type).
 *   2. "cancel mid-stream issues DELETE" — start a speak call, cancel
 *      before the provider finishes; assert the bot saw a DELETE to
 *      `/play_audio/<streamId>` with the bearer token.
 *   3. "unknown stream cancel is a no-op" — `cancel("nope")` does not
 *      throw and does not emit any HTTP traffic.
 */

import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../../../../assistant/src/tts/types.js";
import {
  BOT_AUDIO_SAMPLE_RATE_HZ,
  MeetTtsBridge,
  MeetTtsCancelledError,
  MeetTtsError,
} from "../tts-bridge.js";

// ---------------------------------------------------------------------------
// Fake bot HTTP server
// ---------------------------------------------------------------------------

interface RecordedPost {
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: Uint8Array;
}

interface RecordedDelete {
  url: string;
  authorization: string | null;
}

interface FakeBotServer {
  url: string;
  port: number;
  posts: RecordedPost[];
  deletes: RecordedDelete[];
  stop: () => Promise<void>;
}

function startFakeBot(): FakeBotServer {
  const posts: RecordedPost[] = [];
  const deletes: RecordedDelete[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST") {
        // Read the full chunked body into a single buffer.
        const chunks: Uint8Array[] = [];
        const reader = req.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        posts.push({
          url: `${url.pathname}${url.search}`,
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: merged,
        });
        return new Response("", { status: 200 });
      }
      if (req.method === "DELETE") {
        deletes.push({
          url: url.pathname,
          authorization: req.headers.get("authorization"),
        });
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 405 });
    },
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("fake bot failed to bind");
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    posts,
    deletes,
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ffmpeg child
// ---------------------------------------------------------------------------

/**
 * Build an object that looks enough like a `ChildProcessWithoutNullStreams`
 * for the bridge's purposes. `stdin` is a sink whose writes are forwarded
 * into `stdout` so a test that doesn't care about transcode behavior just
 * sees the provider's bytes flow through unchanged. Tests that want to
 * observe cancel behavior can leave `stdout` open indefinitely.
 */
interface FakeFfmpegChild extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

function makeFakeFfmpegChild(options?: {
  passThroughStdin?: boolean;
}): FakeFfmpegChild {
  const emitter = new EventEmitter() as FakeFfmpegChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const passThrough = options?.passThroughStdin !== false;
  const stdin = new Writable({
    write(chunk, _encoding, cb) {
      if (passThrough) {
        stdout.write(chunk, cb);
      } else {
        cb();
      }
    },
    final(cb) {
      if (passThrough) stdout.end();
      cb();
    },
  });
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.killed = false;
  emitter.kill = (_signal?: string) => {
    emitter.killed = true;
    try {
      stdout.end();
    } catch {
      /* best-effort */
    }
    return true;
  };
  return emitter;
}

/**
 * Build a fake child that satisfies the `ffmpeg -version` probe — emits
 * an `exit` event on the next tick so {@link MeetTtsBridge.ensureFfmpegAvailable}
 * resolves `{ available: true }`.
 */
function makeFakeProbeChild(): FakeFfmpegChild {
  const child = makeFakeFfmpegChild();
  setImmediate(() => child.emit("exit", 0, null));
  return child;
}

function makeSpawnMock(options?: { passThroughStdin?: boolean }): {
  spawn: typeof import("node:child_process").spawn;
  lastChild: () => FakeFfmpegChild | null;
} {
  let child: FakeFfmpegChild | null = null;
  const spawn = mock((..._args: unknown[]) => {
    // The ffmpeg -version probe is a separate spawn from the transcode
    // pipeline. Recognize it by its single `-version` argument and
    // respond with a synthetic "exit 0" so the probe succeeds by default.
    const maybeArgs = _args[1];
    const isProbe =
      Array.isArray(maybeArgs) &&
      maybeArgs.length === 1 &&
      maybeArgs[0] === "-version";
    if (isProbe) {
      return makeFakeProbeChild() as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    }
    child = makeFakeFfmpegChild(options);
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as unknown as typeof import("node:child_process").spawn;
  return {
    spawn,
    lastChild: () => child,
  };
}

// ---------------------------------------------------------------------------
// Fake TTS provider
// ---------------------------------------------------------------------------

interface CannedProviderOptions {
  chunks: Uint8Array[];
  /** Delay (ms) between chunks — defaults to 0 for synchronous emission. */
  gapMs?: number;
}

function makeCannedProvider(options: CannedProviderOptions): TtsProvider & {
  calls: TtsSynthesisRequest[];
} {
  const calls: TtsSynthesisRequest[] = [];
  const provider: TtsProvider & { calls: TtsSynthesisRequest[] } = {
    id: "canned-test-provider",
    capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
    calls,
    async synthesize(request): Promise<TtsSynthesisResult> {
      // Not used by the bridge but required by the contract.
      calls.push(request);
      const merged = Buffer.concat(options.chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
    async synthesizeStream(request, onChunk): Promise<TtsSynthesisResult> {
      calls.push(request);
      for (const chunk of options.chunks) {
        if (request.signal?.aborted) {
          throw new Error("aborted");
        }
        onChunk(chunk);
        if (options.gapMs && options.gapMs > 0) {
          await new Promise((r) => setTimeout(r, options.gapMs));
        }
      }
      const merged = Buffer.concat(options.chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN = "test-token-xyz";
const MEETING_ID = "m-tts-bridge-test";

let fakeBot: FakeBotServer;

beforeEach(() => {
  fakeBot = startFakeBot();
});

afterEach(async () => {
  await fakeBot.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetTtsBridge.speak", () => {
  test("pipes provider chunks through ffmpeg to the bot's /play_audio POST", async () => {
    const payload = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10]),
    ];
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const provider = makeCannedProvider({ chunks: payload });
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-abc",
      },
    );

    const result = await bridge.speak({
      text: "hello world",
      voice: "voice-1",
    });
    expect(result.streamId).toBe("stream-abc");

    // Wait for the POST to complete.
    await result.completion;

    // Assert: exactly one POST landed on the fake bot with the right URL,
    // headers, and body bytes.
    expect(fakeBot.posts).toHaveLength(1);
    const post = fakeBot.posts[0]!;
    expect(post.url).toBe("/play_audio?stream_id=stream-abc");
    expect(post.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.contentType).toBe("application/octet-stream");
    expect(Array.from(post.body)).toEqual(Array.from(expected));

    // Assert: no DELETE was issued on the happy path.
    expect(fakeBot.deletes).toHaveLength(0);

    // Assert: provider was invoked with the expected surface + voice.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.text).toBe("hello world");
    expect(provider.calls[0]!.voiceId).toBe("voice-1");
    expect(provider.calls[0]!.useCase).toBe("message-playback");

    // No active streams linger after completion.
    expect(bridge.activeStreamCount()).toBe(0);
  });

  test("cancel mid-stream aborts POST and issues DELETE /play_audio/<id>", async () => {
    // Use a long gap between chunks so cancel can land before the provider
    // finishes. The first chunk is emitted immediately so the POST has
    // opened before we cancel.
    const payload = [
      new Uint8Array([0xaa, 0xbb]),
      new Uint8Array([0xcc, 0xdd]),
      new Uint8Array([0xee, 0xff]),
    ];
    const provider = makeCannedProvider({ chunks: payload, gapMs: 200 });
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-cancel",
      },
    );

    const { streamId, completion } = await bridge.speak({
      text: "will be cancelled",
    });
    expect(streamId).toBe("stream-cancel");

    // Give the first chunk a chance to flow so the POST has opened.
    await new Promise((r) => setTimeout(r, 50));

    // Cancel. The bridge aborts the outbound POST and fires a DELETE.
    await bridge.cancel(streamId);

    // The completion promise should have settled by now (cancel awaits).
    // On cancel, `completion` rejects with a typed sentinel so the session
    // manager's classifier can publish `reason: "cancelled"` — asserting
    // the shape here locks in the contract.
    let caught: unknown;
    try {
      await completion;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeetTtsCancelledError);
    expect((caught as MeetTtsCancelledError).code).toBe("MEET_TTS_CANCELLED");

    // The bot may or may not have recorded the partial POST (depending on
    // timing — we only require that the DELETE arrived). In practice Bun
    // records the POST when the client abort arrives; either way we assert
    // the DELETE shape.
    expect(fakeBot.deletes).toHaveLength(1);
    const del = fakeBot.deletes[0]!;
    expect(del.url).toBe("/play_audio/stream-cancel");
    expect(del.authorization).toBe(`Bearer ${TOKEN}`);

    // Active stream map is empty after cancel settles.
    expect(bridge.activeStreamCount()).toBe(0);
  });

  test("cancel on an unknown streamId is a no-op", async () => {
    const provider = makeCannedProvider({ chunks: [] });
    const { spawn } = makeSpawnMock();
    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
      },
    );

    await bridge.cancel("never-existed");
    expect(fakeBot.deletes).toHaveLength(0);
    expect(fakeBot.posts).toHaveLength(0);
  });

  test("rejects with MEET_TTS_FFMPEG_UNAVAILABLE when ffmpeg probe hits ENOENT", async () => {
    // Model a machine without ffmpeg installed: the first spawn call
    // (`ffmpeg -version`, the probe) emits an async `error` event with
    // code `ENOENT` — the exact shape Node produces when the binary is
    // missing from PATH. The bridge must translate that into a typed
    // MeetTtsError with code MEET_TTS_FFMPEG_UNAVAILABLE rather than
    // letting it cascade into an opaque downstream failure.
    const provider = makeCannedProvider({ chunks: [new Uint8Array([1, 2])] });
    let probeSpawnCalls = 0;
    let transcodeSpawnCalls = 0;
    const spawn = mock((..._args: unknown[]) => {
      const maybeArgs = _args[1];
      const isProbe =
        Array.isArray(maybeArgs) &&
        maybeArgs.length === 1 &&
        maybeArgs[0] === "-version";
      if (isProbe) {
        probeSpawnCalls += 1;
        const child = makeFakeFfmpegChild();
        const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        setImmediate(() => child.emit("error", err));
        return child as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      }
      transcodeSpawnCalls += 1;
      const child = makeFakeFfmpegChild();
      return child as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    }) as unknown as typeof import("node:child_process").spawn;

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-noffmpeg",
      },
    );

    // The speak() promise should reject with a MeetTtsError carrying the
    // MEET_TTS_FFMPEG_UNAVAILABLE code. Callers (meet_speak tool, etc.)
    // can inspect `.code` to distinguish missing-binary from transient
    // bot/network failures.
    await expect(bridge.speak({ text: "hi" })).rejects.toMatchObject({
      name: "MeetTtsError",
      code: "MEET_TTS_FFMPEG_UNAVAILABLE",
    });

    // The bridge must not have spawned the transcode pipeline at all —
    // the probe short-circuit catches ENOENT before any stream state is
    // allocated.
    expect(probeSpawnCalls).toBe(1);
    expect(transcodeSpawnCalls).toBe(0);
    expect(fakeBot.posts).toHaveLength(0);
    expect(bridge.activeStreamCount()).toBe(0);

    // Second speak() call reuses the cached probe result — no extra
    // spawn, same typed error. This proves the probe is memoized.
    await expect(bridge.speak({ text: "hi again" })).rejects.toMatchObject({
      name: "MeetTtsError",
      code: "MEET_TTS_FFMPEG_UNAVAILABLE",
    });
    expect(probeSpawnCalls).toBe(1);
    expect(transcodeSpawnCalls).toBe(0);

    // Sanity: the thrown error really is a MeetTtsError (instanceof check)
    // so downstream error handling that branches on `err instanceof
    // MeetTtsError` works.
    const caught = await bridge
      .speak({ text: "once more" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(MeetTtsError);
    expect((caught as MeetTtsError).code).toBe("MEET_TTS_FFMPEG_UNAVAILABLE");
  });
});

describe("MeetTtsBridge abort reason classification", () => {
  test("ffmpeg error mid-stream surfaces as MeetTtsError, not MeetTtsCancelledError", async () => {
    // Regression: after #25989, runPost threw MeetTtsCancelledError whenever
    // abort.signal.aborted was true — including when the ffmpeg child's
    // `error` event handler called abort.abort(err) with a raw ErrnoException.
    // The session manager's classifier then misclassified the failure as
    // reason=cancelled instead of reason=error.
    //
    // This test simulates an ffmpeg crash mid-stream: the provider starts
    // emitting chunks, the ffmpeg child emits an `error` event (which the
    // bridge catches and calls abort.abort(err)), and the completion promise
    // must reject with something that is NOT a MeetTtsCancelledError so the
    // session manager can emit reason=error.
    const payload = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
    ];
    const provider = makeCannedProvider({ chunks: payload, gapMs: 100 });

    let transcodeChild: FakeFfmpegChild | null = null;
    const spawn = mock((..._args: unknown[]) => {
      const maybeArgs = _args[1];
      const isProbe =
        Array.isArray(maybeArgs) &&
        maybeArgs.length === 1 &&
        maybeArgs[0] === "-version";
      if (isProbe) {
        return makeFakeProbeChild() as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      }
      transcodeChild = makeFakeFfmpegChild();
      return transcodeChild as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    }) as unknown as typeof import("node:child_process").spawn;

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-ffmpeg-crash",
      },
    );

    const { completion } = await bridge.speak({ text: "will crash" });

    // Give the first chunk time to flow before crashing ffmpeg.
    await new Promise((r) => setTimeout(r, 30));

    // Simulate an ffmpeg runtime error (e.g. SIGKILL, I/O error).
    const ffmpegErr = new Error(
      "ffmpeg process exited unexpectedly",
    ) as NodeJS.ErrnoException;
    ffmpegErr.code = "EPIPE";
    transcodeChild!.emit("error", ffmpegErr);

    // The completion must reject, but NOT with MeetTtsCancelledError.
    let caught: unknown;
    try {
      await completion;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(MeetTtsCancelledError);
    // The original ffmpeg error should propagate through.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "ffmpeg process exited unexpectedly",
    );

    // Active stream map is clean after settlement.
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.activeStreamCount()).toBe(0);
  });

  test("provider synthesizeStream rejection mid-stream surfaces as Error, not MeetTtsCancelledError", async () => {
    // Regression: the provider's synthesizeStream .catch handler calls
    // abort.abort(err) with the provider's rejection. After #25989, runPost
    // treated any aborted signal as a cancel, losing the real error.
    //
    // This test uses a provider that rejects after its first chunk.

    const rejectingProvider: TtsProvider = {
      id: "rejecting-test-provider",
      capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
      async synthesize(): Promise<{ audio: Buffer; contentType: string }> {
        throw new Error("not implemented");
      },
      async synthesizeStream(_request, onChunk) {
        // Emit one chunk successfully, then reject.
        onChunk(new Uint8Array([0xaa, 0xbb]));
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("provider upstream 503: service unavailable");
      },
    };

    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => rejectingProvider,
        spawn,
        newStreamId: () => "stream-provider-reject",
      },
    );

    const { completion } = await bridge.speak({ text: "will reject" });

    let caught: unknown;
    try {
      await completion;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(MeetTtsCancelledError);
    // The propagated error should be the provider's original rejection or
    // a wrapper that preserves the original message.
    expect(caught).toBeInstanceOf(Error);

    // Active stream map is clean after settlement.
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.activeStreamCount()).toBe(0);
  });

  test("caller cancel still produces MeetTtsCancelledError (not regressed)", async () => {
    // Ensure the fix doesn't break the happy cancel path: when cancel() is
    // called, the abort.signal.reason is a MeetTtsCancelledError, so
    // runPost should still throw MeetTtsCancelledError.
    const payload = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
    ];
    const provider = makeCannedProvider({ chunks: payload, gapMs: 200 });
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-cancel-ok",
      },
    );

    const { streamId, completion } = await bridge.speak({
      text: "will be cancelled normally",
    });

    // Give the POST time to open.
    await new Promise((r) => setTimeout(r, 50));

    // Cancel via the bridge's cancel method — this sets abort.signal.reason
    // to a MeetTtsCancelledError.
    await bridge.cancel(streamId);

    let caught: unknown;
    try {
      await completion;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeetTtsCancelledError);
    expect((caught as MeetTtsCancelledError).code).toBe("MEET_TTS_CANCELLED");
    expect(bridge.activeStreamCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resampling hot-path test (uses the real ffmpeg binary)
// ---------------------------------------------------------------------------
//
// This test guards the chipmunk-audio bug: if the bridge forwarded
// provider-native-rate PCM straight to the bot, pacat would play it back
// at 48 kHz (its fixed playback rate), producing sped-up/chipmunk audio.
// The bridge runs ffmpeg with `-ar 48000 -ac 1` on the OUTPUT side, which
// resamples any rate to 48 kHz before the HTTP POST body opens.
//
// We use the real ffmpeg binary (mocking it out would defeat the purpose
// of the test — we're proving the spawn args actually cause resampling)
// but keep the rest of the bridge's dependencies as fakes: the TTS
// provider emits a well-formed 24 kHz WAV payload, and a throwaway
// Bun.serve server stands in for the bot. If ffmpeg isn't installed on
// the machine, the test self-skips rather than failing.

/**
 * Build a minimal canonical PCM WAV header for raw 16-bit signed
 * little-endian samples at the given rate/channel count. We generate
 * the container in-test so the provider emits bytes ffmpeg can decode
 * without us having to ship a fixture file or shell out to `sox`.
 */
function buildPcmWavBuffer(options: {
  sampleRateHz: number;
  channels: number;
  samples: Int16Array;
}): Uint8Array {
  const { sampleRateHz, channels, samples } = options;
  const bitsPerSample = 16;
  const byteRate = (sampleRateHz * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataLen = samples.byteLength;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  // RIFF chunk descriptor
  view.setUint8(0, 0x52); // 'R'
  view.setUint8(1, 0x49); // 'I'
  view.setUint8(2, 0x46); // 'F'
  view.setUint8(3, 0x46); // 'F'
  view.setUint32(4, 36 + dataLen, true);
  view.setUint8(8, 0x57); // 'W'
  view.setUint8(9, 0x41); // 'A'
  view.setUint8(10, 0x56); // 'V'
  view.setUint8(11, 0x45); // 'E'
  // fmt sub-chunk
  view.setUint8(12, 0x66); // 'f'
  view.setUint8(13, 0x6d); // 'm'
  view.setUint8(14, 0x74); // 't'
  view.setUint8(15, 0x20); // ' '
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM audio format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data sub-chunk
  view.setUint8(36, 0x64); // 'd'
  view.setUint8(37, 0x61); // 'a'
  view.setUint8(38, 0x74); // 't'
  view.setUint8(39, 0x61); // 'a'
  view.setUint32(40, dataLen, true);
  // PCM samples
  const out = new Uint8Array(buffer);
  const sampleBytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  out.set(sampleBytes, 44);
  return out;
}

function isFfmpegOnPath(): boolean {
  try {
    // Use execFileSync for the probe instead of spawn — Bun's spawn
    // throws a synchronous error that leaks as an "unhandled error
    // between tests" even inside try/catch at module scope.
    const { execFileSync } = require("node:child_process");
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("MeetTtsBridge resampling hot-path (real ffmpeg)", () => {
  const ffmpegAvailable = isFfmpegOnPath();

  test.if(ffmpegAvailable)(
    "resamples 24 kHz provider PCM to 48 kHz before POSTing to the bot",
    async () => {
      // Synthesize 500 ms of silence at 24 kHz mono s16le — the exact
      // content doesn't matter; we only care about byte counts in/out.
      const inputSampleRateHz = 24_000;
      const durationSeconds = 0.5;
      const inputSampleCount = Math.round(inputSampleRateHz * durationSeconds);
      const pcm24k = new Int16Array(inputSampleCount); // all zeros = silence
      const wavPayload = buildPcmWavBuffer({
        sampleRateHz: inputSampleRateHz,
        channels: 1,
        samples: pcm24k,
      });
      const provider = makeCannedProvider({ chunks: [wavPayload] });

      const bridge = new MeetTtsBridge(
        {
          meetingId: MEETING_ID,
          botBaseUrl: fakeBot.url,
          botApiToken: TOKEN,
        },
        {
          providerFactory: () => provider,
          // Use the REAL ffmpeg binary — this is the whole point of the
          // test. If the bridge ever regressed to streaming provider
          // bytes directly (no ffmpeg) or to using the wrong sample rate
          // args, the output byte count would fall outside the expected
          // window below.
          spawn: realSpawn,
          newStreamId: () => "stream-resample",
        },
      );

      const result = await bridge.speak({ text: "hello 48k world" });
      await result.completion;

      expect(fakeBot.posts).toHaveLength(1);
      const post = fakeBot.posts[0]!;
      expect(post.url).toBe("/play_audio?stream_id=stream-resample");

      // Expected output: 48 kHz mono s16le = 2 bytes/sample.
      // 500 ms @ 48 kHz = 24_000 samples = 48_000 bytes.
      const expectedBytes = Math.round(
        0.5 * BOT_AUDIO_SAMPLE_RATE_HZ * 2, // 2 bytes per sample
      );
      // Allow ~100 ms of slack on either side for ffmpeg's resampler
      // boundary handling (libswresample may add/drop a small number
      // of samples around container edges).
      const tolerance = 0.1 * BOT_AUDIO_SAMPLE_RATE_HZ * 2; // 9600 bytes
      expect(post.body.byteLength).toBeGreaterThan(expectedBytes - tolerance);
      expect(post.body.byteLength).toBeLessThan(expectedBytes + tolerance);

      // Crucially: prove we did NOT forward the raw 24 kHz stream — if
      // resampling were broken, the body would be roughly equal to the
      // input WAV payload size (~24_044 bytes) rather than ~48_000.
      // Assert the output is significantly larger than the raw input
      // would be, which can only happen if ffmpeg resampled.
      expect(post.body.byteLength).toBeGreaterThan(wavPayload.byteLength);

      expect(bridge.activeStreamCount()).toBe(0);
    },
  );
});

describe("MeetTtsBridge constructor validation", () => {
  test("throws when meetingId is empty", () => {
    expect(
      () =>
        new MeetTtsBridge(
          { meetingId: "", botBaseUrl: "http://x", botApiToken: "t" },
          { providerFactory: () => makeCannedProvider({ chunks: [] }) },
        ),
    ).toThrow(/meetingId is required/);
  });

  test("throws when botBaseUrl is empty", () => {
    expect(
      () =>
        new MeetTtsBridge(
          { meetingId: "m", botBaseUrl: "", botApiToken: "t" },
          { providerFactory: () => makeCannedProvider({ chunks: [] }) },
        ),
    ).toThrow(/botBaseUrl is required/);
  });

  test("throws when botApiToken is empty", () => {
    expect(
      () =>
        new MeetTtsBridge(
          { meetingId: "m", botBaseUrl: "http://x", botApiToken: "" },
          { providerFactory: () => makeCannedProvider({ chunks: [] }) },
        ),
    ).toThrow(/botApiToken is required/);
  });
});
