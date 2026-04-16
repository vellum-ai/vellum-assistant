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

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../../../../assistant/src/tts/types.js";
import { MeetTtsBridge, MeetTtsCancelledError } from "../tts-bridge.js";

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

function makeSpawnMock(options?: { passThroughStdin?: boolean }): {
  spawn: ReturnType<typeof mock>;
  lastChild: () => FakeFfmpegChild | null;
} {
  let child: FakeFfmpegChild | null = null;
  const spawn = mock(() => {
    child = makeFakeFfmpegChild(options);
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  });
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

    const result = await bridge.speak({ text: "hello world", voice: "voice-1" });
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
