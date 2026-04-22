/**
 * Unit tests for the TTS lip-sync tap:
 *   - `MeetTtsBridge`'s `onViseme` channel (provider-alignment path +
 *     RMS-amplitude fallback).
 *   - `startTtsLipsync()` forwarding events to `POST /avatar/viseme` and
 *     tolerating HTTP errors.
 *
 * These tests exercise both halves of the PR 4 contract:
 *   1. A provider that advertises `capabilities.alignment = true` drives
 *      viseme events through the alignment callback — no RMS extractor
 *      runs.
 *   2. A provider that does not advertise alignment triggers the
 *      amplitude-envelope fallback; events are emitted with
 *      `phoneme === "amp"` at 50 ms cadence.
 *   3. The forwarder POSTs events to the bot and swallows 404 /
 *      network errors (bot hasn't deployed PR 5 yet, or is briefly
 *      unreachable).
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TtsAlignmentEvent,
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../../../../assistant/src/tts/types.js";
import { MeetTtsBridge } from "../tts-bridge.js";
import type { VisemeEvent } from "../tts-bridge.js";
import {
  DEFAULT_LIPSYNC_REQUEST_TIMEOUT_MS,
  startTtsLipsync,
} from "../tts-lipsync.js";

// ---------------------------------------------------------------------------
// Fake ffmpeg child — identical to `tts-bridge.test.ts` but inlined to keep
// the two files independently runnable.
// ---------------------------------------------------------------------------

interface FakeFfmpegChild extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

function makeFakeFfmpegChild(): FakeFfmpegChild {
  const emitter = new EventEmitter() as FakeFfmpegChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, cb) {
      stdout.write(chunk, cb);
    },
    final(cb) {
      stdout.end();
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

function makeFakeProbeChild(): FakeFfmpegChild {
  const child = makeFakeFfmpegChild();
  setImmediate(() => child.emit("exit", 0, null));
  return child;
}

function makeSpawnMock(): {
  spawn: typeof import("node:child_process").spawn;
} {
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
    return makeFakeFfmpegChild() as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn };
}

// ---------------------------------------------------------------------------
// Fake bot server — accepts POSTs to /play_audio and /avatar/viseme.
// ---------------------------------------------------------------------------

interface RecordedViseme {
  authorization: string | null;
  contentType: string | null;
  body: VisemeEvent;
}

interface FakeBot {
  url: string;
  visemes: RecordedViseme[];
  /** Total bytes received on `/play_audio` POSTs across all streams. */
  playAudioBytes: number;
  /**
   * When set, every `/avatar/viseme` POST replies with this status. Used
   * to verify 4xx/5xx tolerance.
   */
  visemeStatusOverride: number | null;
  stop: () => Promise<void>;
}

function startFakeBot(): FakeBot {
  const visemes: RecordedViseme[] = [];
  const state: FakeBot = {
    url: "",
    visemes,
    playAudioBytes: 0,
    visemeStatusOverride: null,
    stop: async () => {
      /* set below */
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/avatar/viseme") {
        let parsed: VisemeEvent | null = null;
        try {
          parsed = (await req.json()) as VisemeEvent;
        } catch {
          return new Response("bad json", { status: 400 });
        }
        visemes.push({
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: parsed,
        });
        if (state.visemeStatusOverride !== null) {
          return new Response("", { status: state.visemeStatusOverride });
        }
        return new Response("", { status: 200 });
      }
      // Drain any /play_audio POST body so the bridge finishes its POST
      // without hanging — not under test here.
      if (req.method === "POST" && url.pathname === "/play_audio") {
        if (req.body) {
          const reader = req.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) state.playAudioBytes += value.byteLength;
          }
        }
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 405 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("fake bot failed to bind");
  state.url = `http://127.0.0.1:${port}`;
  state.stop = async () => {
    await server.stop(true);
  };
  return state;
}

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

/** Build a provider that does NOT emit alignment events. */
function makePlainProvider(chunks: Uint8Array[]): TtsProvider {
  return {
    id: "fake-plain-provider",
    capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
    async synthesize(_req: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
    async synthesizeStream(
      _req: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      for (const chunk of chunks) {
        onChunk(chunk);
      }
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
  };
}

/** Build a provider that DOES emit alignment events. */
function makeAlignmentProvider(
  chunks: Uint8Array[],
  alignments: TtsAlignmentEvent[],
): TtsProvider {
  return {
    id: "fake-alignment-provider",
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["pcm"],
      alignment: true,
    },
    async synthesize(_req: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
    async synthesizeStream(
      _req: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
      onAlignment?: (event: TtsAlignmentEvent) => void,
    ): Promise<TtsSynthesisResult> {
      for (const chunk of chunks) {
        onChunk(chunk);
      }
      for (const event of alignments) {
        onAlignment?.(event);
      }
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return { audio: merged, contentType: "audio/pcm" };
    },
  };
}

// ---------------------------------------------------------------------------
// Audio helpers — build a PCM buffer of a given duration at peak loudness.
// ---------------------------------------------------------------------------

/**
 * Build an s16le / mono / 48 kHz buffer of the given duration with samples
 * set to `amplitude` (useful for deterministic RMS windows).
 */
function makeConstantPcm(durationMs: number, amplitude: number): Uint8Array {
  const sampleRate = 48_000;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const bytes = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    bytes.writeInt16LE(amplitude, i * 2);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN = "lip-sync-token";
const MEETING_ID = "m-tts-lipsync-test";

let fakeBot: FakeBot;

beforeEach(() => {
  fakeBot = startFakeBot();
});

afterEach(async () => {
  await fakeBot.stop();
});

// ---------------------------------------------------------------------------
// Bridge `onViseme` behavior
// ---------------------------------------------------------------------------

describe("MeetTtsBridge.onViseme — provider alignment path", () => {
  test("forwards provider-emitted alignment events as VisemeEvents", async () => {
    const payload = [makeConstantPcm(30, 8000)];
    const alignments: TtsAlignmentEvent[] = [
      { phoneme: "a", weight: 0.3, timestamp: 10 },
      { phoneme: "e", weight: 0.7, timestamp: 25 },
    ];
    const provider = makeAlignmentProvider(payload, alignments);
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
        newStreamId: () => "stream-align",
        newUtteranceId: () => "utt-align",
      },
    );

    const events: VisemeEvent[] = [];
    bridge.onViseme((e) => events.push(e));

    const { completion } = await bridge.speak({ text: "hi" });
    await completion;

    // Only the alignment events should have been forwarded; no "amp"
    // fallback entries since the provider advertised alignment support.
    // The bridge stamps every viseme with both the active stream id and
    // a per-speak utterance id so the bot can distinguish prior-utterance
    // debris (including from a cancelled prior speak that reused this
    // stream id) from events racing ahead of a fresh `/play_audio` POST.
    expect(events).toEqual([
      {
        phoneme: "a",
        weight: 0.3,
        timestamp: 10,
        streamId: "stream-align",
        utteranceId: "utt-align",
      },
      {
        phoneme: "e",
        weight: 0.7,
        timestamp: 25,
        streamId: "stream-align",
        utteranceId: "utt-align",
      },
    ]);
    expect(events.every((e) => e.phoneme !== "amp")).toBe(true);
  });

  test("clamps out-of-range alignment weights into [0, 1]", async () => {
    const payload = [makeConstantPcm(20, 4000)];
    const provider = makeAlignmentProvider(payload, [
      { phoneme: "x", weight: -0.2, timestamp: 0 },
      { phoneme: "y", weight: 1.4, timestamp: 10 },
      { phoneme: "z", weight: Number.NaN, timestamp: 20 },
    ]);
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
        newStreamId: () => "stream-clamp",
      },
    );

    const events: VisemeEvent[] = [];
    bridge.onViseme((e) => events.push(e));
    const { completion } = await bridge.speak({ text: "clamp" });
    await completion;

    expect(events).toHaveLength(3);
    expect(events[0]!.weight).toBe(0);
    expect(events[1]!.weight).toBe(1);
    expect(events[2]!.weight).toBe(0);
  });

  test("skips alignment plumbing when no subscribers are registered", async () => {
    const payload = [makeConstantPcm(30, 8000)];
    // If the bridge called `onAlignment` despite no subscribers, we'd see
    // a test failure here because the provider's `onAlignment` would be
    // defined — assert via a spy that it was not called.
    let onAlignmentSpy: ((e: TtsAlignmentEvent) => void) | undefined;
    const provider: TtsProvider = {
      id: "fake-alignment-provider-spy",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["pcm"],
        alignment: true,
      },
      async synthesize(_req) {
        return {
          audio: Buffer.from(payload[0]!),
          contentType: "audio/pcm",
        };
      },
      async synthesizeStream(_req, onChunk, onAlignment) {
        onAlignmentSpy = onAlignment;
        for (const chunk of payload) onChunk(chunk);
        return {
          audio: Buffer.from(payload[0]!),
          contentType: "audio/pcm",
        };
      },
    };
    const { spawn } = makeSpawnMock();
    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-no-sub",
      },
    );
    const { completion } = await bridge.speak({ text: "skip" });
    await completion;
    // With no subscribers, the bridge should not have passed an
    // `onAlignment` callback down to the provider.
    expect(onAlignmentSpy).toBeUndefined();
  });
});

describe("MeetTtsBridge.onViseme — amplitude fallback path", () => {
  test("emits 'amp' viseme events at 50ms cadence when provider lacks alignment", async () => {
    // 200 ms of steady audio at half-scale amplitude → 4 RMS windows.
    const amplitude = 16_384;
    const payload = [makeConstantPcm(200, amplitude)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-amp",
      },
    );

    const events: VisemeEvent[] = [];
    bridge.onViseme((e) => events.push(e));

    const { completion } = await bridge.speak({ text: "amp" });
    await completion;

    expect(events.length).toBeGreaterThanOrEqual(4);
    // Every event must be an amplitude fallback.
    for (const e of events) {
      expect(e.phoneme).toBe("amp");
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(1);
    }
    // Timestamps must be strictly monotonically increasing with 50 ms spacing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.timestamp - events[i - 1]!.timestamp).toBe(50);
    }
    // First window's timestamp is 0 (start of utterance).
    expect(events[0]!.timestamp).toBe(0);
    // RMS of a constant amplitude `a` is `a`. Weight = 16384 / 32768 = 0.5.
    // Allow a small epsilon for float accumulation.
    expect(events[0]!.weight).toBeGreaterThan(0.4);
    expect(events[0]!.weight).toBeLessThan(0.6);
  });

  test("amplitude tap does not steal bytes from the bot's /play_audio body", async () => {
    // Regression: the tap was previously a `.on("data")` listener on a
    // PassThrough that was then converted to the HTTP body — two flowing-
    // mode consumers raced for chunks and some bytes were dropped. Sending
    // a large payload with subscribers active must still deliver every
    // byte to the bot.
    const amplitude = 16_384;
    const payload = [makeConstantPcm(500, amplitude)];
    const expectedBytes = payload[0]!.byteLength;
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-no-steal",
      },
    );

    bridge.onViseme(() => {
      /* presence of a subscriber activates the tap */
    });

    const before = fakeBot.playAudioBytes;
    const { completion } = await bridge.speak({ text: "no-steal" });
    await completion;

    expect(fakeBot.playAudioBytes - before).toBe(expectedBytes);
  });

  test("does not run the amplitude tap when no subscribers are registered", async () => {
    // Use a plain provider that would otherwise trigger the fallback; if
    // the bridge still installed the tap it would fire events we've
    // subscribed to afterwards (we don't subscribe here, so silence is
    // the signal of correctness — assert no events after subscribing
    // post-speak).
    const payload = [makeConstantPcm(100, 16_000)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-no-tap",
      },
    );

    const { completion } = await bridge.speak({ text: "silent" });
    await completion;

    // Subscribing after the call completes must receive nothing — the tap
    // was never installed for that call.
    const events: VisemeEvent[] = [];
    bridge.onViseme((e) => events.push(e));
    // Give any hypothetical late emissions a chance to land.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });

  test("onViseme returns an unsubscribe that stops further delivery", async () => {
    const amplitude = 16_384;
    const payload = [makeConstantPcm(100, amplitude)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-unsub",
      },
    );

    const beforeEvents: VisemeEvent[] = [];
    const afterEvents: VisemeEvent[] = [];
    const unsub = bridge.onViseme((e) => beforeEvents.push(e));
    unsub();
    bridge.onViseme((e) => afterEvents.push(e));

    const { completion } = await bridge.speak({ text: "unsub" });
    await completion;

    expect(beforeEvents).toEqual([]);
    expect(afterEvents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// `startTtsLipsync` forwarder
// ---------------------------------------------------------------------------

describe("startTtsLipsync", () => {
  test("forwards viseme events to POST /avatar/viseme with auth header", async () => {
    const amplitude = 16_384;
    const payload = [makeConstantPcm(100, amplitude)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-forward",
      },
    );

    const observed: VisemeEvent[] = [];
    const handle = startTtsLipsync({
      bridge,
      botApiToken: TOKEN,
      onEvent: (e) => observed.push(e),
    });

    const { completion } = await bridge.speak({ text: "forward" });
    await completion;

    // Wait briefly for outbound POSTs to settle (fire-and-forget).
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    // We observed at least one amplitude window — assert the bot saw a
    // matching number of POSTs (minus at most a few still in flight; in
    // practice all complete under 50 ms against a local Bun.serve).
    expect(observed.length).toBeGreaterThan(0);
    expect(fakeBot.visemes.length).toBeGreaterThan(0);

    // Headers and body shape are validated on the very first recorded
    // POST — they must all be identical.
    const first = fakeBot.visemes[0]!;
    expect(first.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first.contentType).toBe("application/json");
    expect(first.body.phoneme).toBe("amp");
    expect(typeof first.body.weight).toBe("number");
    expect(typeof first.body.timestamp).toBe("number");
  });

  test("tolerates 404 responses from a bot that hasn't deployed /avatar/viseme", async () => {
    fakeBot.visemeStatusOverride = 404;

    const payload = [makeConstantPcm(100, 16_384)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-404",
      },
    );

    const observed: VisemeEvent[] = [];
    const handle = startTtsLipsync({
      bridge,
      botApiToken: TOKEN,
      onEvent: (e) => observed.push(e),
    });

    const { completion } = await bridge.speak({ text: "404-ok" });
    // The speak pipeline must not surface a rejection from the
    // 404-returning forwarder — it must complete cleanly.
    await expect(completion).resolves.toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(observed.length).toBeGreaterThan(0);
    // The bot recorded the POSTs even though it replied 404 — forwarder
    // did not give up or crash after the first 404.
    expect(fakeBot.visemes.length).toBe(observed.length);
  });

  test("tolerates network errors on the forwarder's POST", async () => {
    const payload = [makeConstantPcm(100, 16_384)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-net-err",
      },
    );

    const observed: VisemeEvent[] = [];
    const fetchErrors: string[] = [];
    const failingFetch = mock(async (url: string | URL) => {
      fetchErrors.push(String(url));
      throw new Error("simulated-network-failure");
    }) as unknown as (
      input: string | URL,
      init?: RequestInit,
    ) => Promise<Response>;

    const handle = startTtsLipsync({
      bridge,
      botApiToken: TOKEN,
      fetch: failingFetch,
      onEvent: (e) => observed.push(e),
    });

    const { completion } = await bridge.speak({ text: "net-err-ok" });
    await expect(completion).resolves.toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    handle.stop();

    expect(observed.length).toBeGreaterThan(0);
    expect(fetchErrors.length).toBe(observed.length);
  });

  test("stop() unsubscribes so subsequent events are not forwarded", async () => {
    const payload = [makeConstantPcm(100, 16_384)];
    const provider = makePlainProvider(payload);
    const { spawn } = makeSpawnMock();

    const bridge = new MeetTtsBridge(
      { meetingId: MEETING_ID, botBaseUrl: fakeBot.url, botApiToken: TOKEN },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-stop",
      },
    );

    const observed: VisemeEvent[] = [];
    const handle = startTtsLipsync({
      bridge,
      botApiToken: TOKEN,
      onEvent: (e) => observed.push(e),
    });
    handle.stop();
    // Calling stop a second time is idempotent.
    handle.stop();

    const { completion } = await bridge.speak({ text: "post-stop" });
    await completion;

    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toEqual([]);
    expect(fakeBot.visemes).toEqual([]);
  });

  test("default request timeout constant is exported for configuration", () => {
    expect(DEFAULT_LIPSYNC_REQUEST_TIMEOUT_MS).toBe(2_000);
  });
});
