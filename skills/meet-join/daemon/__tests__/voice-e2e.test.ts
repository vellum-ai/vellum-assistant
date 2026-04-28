/**
 * Daemon-side voice E2E test.
 *
 * Wires the real {@link MeetTtsBridge} and the real {@link MeetBargeInWatcher}
 * against a throwaway `Bun.serve` HTTP server playing the role of the
 * meet-bot's `/play_audio` + `DELETE /play_audio/:streamId` endpoints. The
 * watcher subscribes to a test-local in-memory event hub that models the
 * production wiring so `meet.speaking_*` lifecycle events flow exactly the
 * way they would in production. The bot-event stream is supplied via an
 * in-memory dispatcher injected through {@link MeetBargeInWatcher}'s
 * `subscribe` hook.
 *
 * The bridge is given a mocked `spawn` so its ffmpeg child is replaced with
 * a `Writable` whose writes pass straight through to a `PassThrough` that
 * fetch consumes as the request body — this is the same pattern used by
 * `tts-bridge.test.ts`. The TTS provider is a canned implementation that
 * emits a recognizable byte sequence so any corruption between provider
 * and bot would surface as a byte-by-byte mismatch.
 *
 * What this test exercises that the unit tests do not:
 *
 *   - End-to-end byte transit from the TTS provider through the bridge to
 *     the bot HTTP endpoint, including the chunked body framing.
 *   - The full meet.speaking_started / meet.speaking_ended lifecycle the
 *     production session manager publishes around `bridge.speak`.
 *   - The barge-in watcher's debounced cancel against the *real* bridge:
 *     a triggered cancel must actually issue DELETE /play_audio to the
 *     bot, and the cancel must be observable exactly once.
 *   - The short-cough debounce: a non-bot speaker event followed by an
 *     immediate return-to-bot speaker event within the 250ms debounce
 *     window must NOT cancel the in-flight speak.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  MeetBotEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
} from "../../contracts/index.js";

import type { ServerMessage } from "@vellumai/skill-host-contracts";
import { buildAssistantEvent } from "@vellumai/skill-host-contracts";

import { InMemoryEventHub } from "../../__tests__/build-test-host.js";
import {
  BARGE_IN_DEBOUNCE_MS,
  MeetBargeInWatcher,
} from "../barge-in-watcher.js";
import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../tts-bridge.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";
import { MeetTtsBridge, MeetTtsCancelledError } from "../tts-bridge.js";

// ---------------------------------------------------------------------------
// Fake bot HTTP server (real Bun.serve)
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
  /** Resolves once the next POST's body has finished streaming. */
  awaitNextPostComplete: () => Promise<RecordedPost>;
  stop: () => Promise<void>;
}

function startFakeBot(): FakeBotServer {
  const posts: RecordedPost[] = [];
  const deletes: RecordedDelete[] = [];
  const postCompletionWaiters: Array<(p: RecordedPost) => void> = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST") {
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
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        const post: RecordedPost = {
          url: `${url.pathname}${url.search}`,
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: merged,
        };
        posts.push(post);
        const waiter = postCompletionWaiters.shift();
        if (waiter) waiter(post);
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
    awaitNextPostComplete: () =>
      new Promise<RecordedPost>((resolve) => {
        postCompletionWaiters.push(resolve);
      }),
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ffmpeg child — stdin pipes straight into stdout. Same pattern as
// `tts-bridge.test.ts`. Lets the bridge see provider chunks materialize as
// HTTP body bytes without invoking a real ffmpeg.
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

function makeSpawnMock(): {
  spawn: typeof import("node:child_process").spawn;
} {
  const spawn = mock((..._args: unknown[]) => {
    // The ffmpeg -version probe is a separate spawn from the transcode
    // pipeline. Respond with a synthetic exit so the probe cache reports
    // "ffmpeg is available" without running the real binary.
    const maybeArgs = _args[1];
    const isProbe =
      Array.isArray(maybeArgs) &&
      maybeArgs.length === 1 &&
      maybeArgs[0] === "-version";
    if (isProbe) {
      const child = makeFakeFfmpegChild();
      setImmediate(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    }
    const child = makeFakeFfmpegChild();
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn };
}

// ---------------------------------------------------------------------------
// Canned TTS provider — emits a deterministic, recognizable byte sequence
// so any corruption between provider and bot would surface immediately.
// ---------------------------------------------------------------------------

function buildSinePcm(samples: number, frequencyHz: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  const sampleRate = 48_000;
  const amplitude = 0x3000;
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate),
    );
    view.setInt16(i * 2, value, /* littleEndian */ true);
  }
  return out;
}

interface CannedProviderOptions {
  chunks: Uint8Array[];
  /** Delay between chunks — defaults to 0 for synchronous emission. */
  gapMs?: number;
}

function makeCannedProvider(options: CannedProviderOptions): TtsProvider & {
  calls: TtsSynthesisRequest[];
} {
  const calls: TtsSynthesisRequest[] = [];
  return {
    id: "canned-voice-e2e-provider",
    capabilities: { supportsStreaming: true, supportedFormats: ["pcm"] },
    calls,
    async synthesize(request): Promise<TtsSynthesisResult> {
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
}

// ---------------------------------------------------------------------------
// In-memory bot-event dispatcher — fans dispatched events to subscribers.
// The watcher uses this in place of the production singleton so the test
// has full control over what events the watcher observes.
// ---------------------------------------------------------------------------

function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
} {
  const subs = new Map<string, Set<MeetEventSubscriber>>();
  return {
    subscribe(meetingId, cb) {
      let set = subs.get(meetingId);
      if (!set) {
        set = new Set();
        subs.set(meetingId, set);
      }
      set.add(cb);
      return () => {
        const existing = subs.get(meetingId);
        if (!existing) return;
        existing.delete(cb);
        if (existing.size === 0) subs.delete(meetingId);
      };
    },
    dispatch(meetingId, event) {
      const set = subs.get(meetingId);
      if (!set) return;
      for (const cb of Array.from(set)) cb(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — publish meet.speaking_* through the test-local event hub the
// way `MeetSessionManager.speak` does in production, and subscribe so the
// test can collect the lifecycle events that flow back through the same
// hub.
// ---------------------------------------------------------------------------

/**
 * Module-scoped in-memory hub shared across all tests in this file. Mirrors
 * the production singleton's subscribe/publish semantics for
 * `DAEMON_INTERNAL_ASSISTANT_ID`-scoped events without reaching into
 * `assistant/`. Each test's `captureHub()` subscribes independently and
 * disposes on completion, so cross-test leakage is bounded to the shared
 * hub's empty-subscribers steady state.
 */
const testHub = new InMemoryEventHub();

function publishToHub(message: ServerMessage): Promise<void> {
  return testHub.publish(buildAssistantEvent(message));
}

/**
 * Poll `predicate` until it returns truthy or `timeoutMs` elapses. Returns
 * the wall-clock time (Date.now()) at which the predicate first became
 * true so callers can measure debounce + cancel latency. Throws on
 * timeout.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return Date.now();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil: predicate did not become true in ${timeoutMs}ms`);
}

interface CapturedHub {
  events: ServerMessage[];
  /** Resolve when the next event matching the predicate arrives. */
  waitFor: (
    predicate: (m: ServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerMessage>;
  dispose: () => void;
}

function captureHub(): CapturedHub {
  const events: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];
  const sub = testHub.subscribe({}, (event) => {
    events.push(event.message);
    // Snapshot so a resolver removing itself mid-iteration doesn't
    // skip a sibling.
    const snapshot = waiters.slice();
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const w = snapshot[i]!;
      if (w.predicate(event.message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event.message);
      }
    }
  });
  return {
    events,
    waitFor: (predicate, timeoutMs = 1500) =>
      new Promise<ServerMessage>((resolve, reject) => {
        // Search the backlog first.
        const existing = events.find((m) => predicate(m));
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === wrappedResolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const wrappedResolve = (m: ServerMessage): void => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push({ predicate, resolve: wrappedResolve });
      }),
    dispose: () => sub.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Lightweight session-manager stand-in — wraps `bridge.speak` with the
// same `meet.speaking_started` / `meet.speaking_ended` publishing the real
// `MeetSessionManager.speak` does, and exposes a `cancelSpeak(meetingId)`
// the watcher can call. Keeps the test focused on the bridge + watcher
// without dragging the entire session-manager dependency graph in.
// ---------------------------------------------------------------------------

interface SessionWrapper {
  speak: (input: { text: string; voice?: string }) => Promise<{
    streamId: string;
    completion: Promise<void>;
  }>;
  cancelSpeak: (meetingId: string) => Promise<void>;
}

function wrapSessionManager(
  meetingId: string,
  bridge: MeetTtsBridge,
): SessionWrapper {
  return {
    async speak(input) {
      const result = await bridge.speak(input);
      void publishToHub({
        type: "meet.speaking_started",
        meetingId,
        streamId: result.streamId,
      });
      void result.completion
        .then(() =>
          publishToHub({
            type: "meet.speaking_ended",
            meetingId,
            streamId: result.streamId,
            reason: "completed" as const,
          }),
        )
        .catch((err) => {
          const isCancel =
            err instanceof MeetTtsCancelledError ||
            (err !== null &&
              typeof err === "object" &&
              (err as { code?: unknown }).code === "MEET_TTS_CANCELLED");
          const reason: "cancelled" | "error" = isCancel
            ? "cancelled"
            : "error";
          void publishToHub({
            type: "meet.speaking_ended",
            meetingId,
            streamId: result.streamId,
            reason,
          });
        });
      return result;
    },
    async cancelSpeak(_id: string) {
      await bridge.cancelAll();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN = "test-token-voice-e2e";
const MEETING_ID = "m-voice-e2e";
const BOT_PARTICIPANT_ID = "bot-self-voice-e2e";
const HUMAN_SPEAKER_ID = "human-bob-e2e";

function participantChangeWithSelf(): ParticipantChangeEvent {
  return {
    type: "participant.change",
    meetingId: MEETING_ID,
    timestamp: "2024-01-01T00:00:00.000Z",
    joined: [{ id: BOT_PARTICIPANT_ID, name: "Aria", isSelf: true }],
    left: [],
  };
}

function speakerChange(
  speakerId: string,
  speakerName = "Bob",
): SpeakerChangeEvent {
  return {
    type: "speaker.change",
    meetingId: MEETING_ID,
    timestamp: "2024-01-01T00:00:00.500Z",
    speakerId,
    speakerName,
  };
}

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

describe("Meet voice E2E (bridge + watcher + real assistant-event-hub)", () => {
  test("happy path: speak('hello') → bytes land at the bot byte-for-byte → meet.speaking_ended fires", async () => {
    // Recognizable PCM so corruption surfaces immediately.
    const payload = [
      buildSinePcm(240, 440), // 480 bytes
      buildSinePcm(240, 880), // 480 bytes
      buildSinePcm(120, 660), // 240 bytes
    ];
    const expected = Buffer.concat(payload.map((c) => Buffer.from(c)));

    const provider = makeCannedProvider({ chunks: payload });
    const { spawn } = makeSpawnMock();
    const dispatcher = makeFakeDispatcher();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-happy",
        newUtteranceId: () => "utt-happy",
        // Disable the fast-fail window: this E2E asserts the watcher
        // observes `_isBotSpeaking=true` while the POST is in-flight,
        // which requires `speak()` to return before the stream settles.
        speakFastFailWindowMs: 0,
      },
    );

    const session = wrapSessionManager(MEETING_ID, bridge);

    const watcher = new MeetBargeInWatcher({
      meetingId: MEETING_ID,
      sessionManager: session,
      subscribe: dispatcher.subscribe,
      subscribeAssistantEvents: (cb) => testHub.subscribe({}, cb),
    });
    watcher.start();

    const captured = captureHub();
    try {
      // Discover the bot's self id so the watcher knows who's "self".
      dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
      expect(watcher._getBotSpeakerId()).toBe(BOT_PARTICIPANT_ID);

      // Kick off the speak — completion resolves once the bot's POST
      // settles. The bot's `await req.body.read()` loop drains every
      // ffmpeg chunk so the merged body is exactly the provider output.
      const postCompletion = fakeBot.awaitNextPostComplete();
      const result = await session.speak({ text: "hello", voice: "v1" });
      expect(result.streamId).toBe("stream-happy");

      // Wait for the assistant-event-hub to see meet.speaking_started —
      // proves the lifecycle wiring fired through the same hub the
      // production code uses.
      await captured.waitFor(
        (m) =>
          m.type === "meet.speaking_started" &&
          (m as { streamId: string }).streamId === "stream-happy",
      );
      expect(watcher._isBotSpeaking()).toBe(true);

      // Wait for the bot to actually receive and finish reading the POST.
      const post = await postCompletion;
      expect(post.url).toBe(
        "/play_audio?stream_id=stream-happy&utterance_id=utt-happy",
      );
      expect(post.authorization).toBe(`Bearer ${TOKEN}`);
      expect(post.contentType).toBe("application/octet-stream");

      // Byte-perfect: the bot's body equals the provider's emitted bytes
      // concatenated in order. (No corruption, no reordering, no drops.)
      expect(Array.from(post.body)).toEqual(Array.from(expected));

      // Wait for the speak completion to settle and for the lifecycle
      // event to flow back through the hub.
      await result.completion;
      const ended = (await captured.waitFor(
        (m) =>
          m.type === "meet.speaking_ended" &&
          (m as { streamId: string }).streamId === "stream-happy",
      )) as { reason: string; streamId: string };
      expect(ended.reason).toBe("completed");

      // Watcher's flag flips back, no DELETE was issued.
      expect(watcher._isBotSpeaking()).toBe(false);
      expect(fakeBot.deletes).toHaveLength(0);
    } finally {
      captured.dispose();
      watcher.stop();
    }
  });

  test("barge-in: non-bot speaker.change while speaking → cancel fires within 300ms", async () => {
    // Use a long inter-chunk gap so the speak is still in flight when we
    // simulate the human speaker. Short-but-not-tiny chunks (the
    // canned provider emits one chunk every 200ms) means the POST is
    // still actively streaming when the cancel lands.
    const provider = makeCannedProvider({
      chunks: [
        buildSinePcm(240, 440),
        buildSinePcm(240, 880),
        buildSinePcm(240, 660),
        buildSinePcm(240, 220),
      ],
      gapMs: 200,
    });
    const { spawn } = makeSpawnMock();
    const dispatcher = makeFakeDispatcher();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-barge",
        // See fast-fail opt-out note on the happy-path bridge above.
        speakFastFailWindowMs: 0,
      },
    );

    // Spy on cancelSpeak so we can assert "called exactly once".
    const baseSession = wrapSessionManager(MEETING_ID, bridge);
    const cancelSpy = mock(async (id: string) => {
      await baseSession.cancelSpeak(id);
    });
    const session = {
      speak: baseSession.speak,
      cancelSpeak: cancelSpy,
    };

    const watcher = new MeetBargeInWatcher({
      meetingId: MEETING_ID,
      sessionManager: session,
      subscribe: dispatcher.subscribe,
      subscribeAssistantEvents: (cb) => testHub.subscribe({}, cb),
    });
    watcher.start();

    const captured = captureHub();
    try {
      dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
      const result = await session.speak({
        text: "I am about to be interrupted",
      });
      expect(result.streamId).toBe("stream-barge");

      await captured.waitFor((m) => m.type === "meet.speaking_started");

      // Give the bridge a beat so the POST is in flight before barge-in.
      await new Promise((r) => setTimeout(r, 60));

      // Non-bot speaker takes the floor — should arm the debounced cancel.
      const tBargeIn = Date.now();
      dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
      expect(watcher._hasPendingCancel()).toBe(true);

      // Wait for the watcher's cancelSpeak invocation. We bound this on
      // the cancelSpy reference so we observe the cancel-fired-at moment
      // independent of the downstream lifecycle event ordering.
      const tCancelObserved = await waitUntil(
        () => cancelSpy.mock.calls.length >= 1,
        500,
      );
      const elapsed = tCancelObserved - tBargeIn;

      // Cancel must have fired exactly once. (Idempotent debounce; no
      // double-fire from sibling triggers.)
      expect(cancelSpy).toHaveBeenCalledTimes(1);

      // The cancel must have landed within the plan's 300ms barge-in
      // budget (250ms debounce + slack for the timer callback + the
      // bridge.cancelAll roundtrip). Lower bound (≥ debounce) proves
      // we didn't fire prematurely.
      expect(elapsed).toBeGreaterThanOrEqual(BARGE_IN_DEBOUNCE_MS);
      expect(elapsed).toBeLessThan(300);

      // The bridge issued DELETE /play_audio/<streamId> on cancel — this
      // is the bot-side observable signal that cancel made it through
      // the bridge, the HTTP layer, and arrived at the fake bot.
      await waitUntil(() => fakeBot.deletes.length >= 1, 500);
      expect(fakeBot.deletes).toHaveLength(1);
      expect(fakeBot.deletes[0]!.url).toBe("/play_audio/stream-barge");
      expect(fakeBot.deletes[0]!.authorization).toBe(`Bearer ${TOKEN}`);

      // Lifecycle event for the cancelled stream flows back through the
      // real assistant-event-hub with reason="cancelled" — locking in the
      // contract that caller-initiated cancels (and barge-in cancels) are
      // observable as such, distinct from natural "completed" finishes.
      const ended = (await captured.waitFor(
        (m) =>
          m.type === "meet.speaking_ended" &&
          (m as { streamId: string }).streamId === "stream-barge",
        1500,
      )) as { reason: string; streamId: string };
      expect(ended.reason).toBe("cancelled");
    } finally {
      captured.dispose();
      watcher.stop();
    }
  });

  test("short cough: non-bot speaker followed within 100ms by bot speaker → no cancel (debounce)", async () => {
    // Fast emission so the speak finishes quickly — but we explicitly
    // assert the cancel-or-not decision *before* the stream completes
    // by holding the speak open long enough for the debounce window
    // (250ms) to elapse fully without firing.
    const provider = makeCannedProvider({
      chunks: [
        buildSinePcm(240, 440),
        buildSinePcm(240, 880),
        buildSinePcm(240, 660),
        buildSinePcm(240, 220),
      ],
      gapMs: 100,
    });
    const { spawn } = makeSpawnMock();
    const dispatcher = makeFakeDispatcher();

    const bridge = new MeetTtsBridge(
      {
        meetingId: MEETING_ID,
        botBaseUrl: fakeBot.url,
        botApiToken: TOKEN,
      },
      {
        providerFactory: () => provider,
        spawn,
        newStreamId: () => "stream-cough",
        // See fast-fail opt-out note on the happy-path bridge above.
        speakFastFailWindowMs: 0,
      },
    );

    const baseSession = wrapSessionManager(MEETING_ID, bridge);
    const cancelSpy = mock(async (id: string) => {
      await baseSession.cancelSpeak(id);
    });
    const session = {
      speak: baseSession.speak,
      cancelSpeak: cancelSpy,
    };

    const watcher = new MeetBargeInWatcher({
      meetingId: MEETING_ID,
      sessionManager: session,
      subscribe: dispatcher.subscribe,
      subscribeAssistantEvents: (cb) => testHub.subscribe({}, cb),
    });
    watcher.start();

    const captured = captureHub();
    try {
      dispatcher.dispatch(MEETING_ID, participantChangeWithSelf());
      const result = await session.speak({ text: "uninterrupted utterance" });
      expect(result.streamId).toBe("stream-cough");

      await captured.waitFor((m) => m.type === "meet.speaking_started");
      await new Promise((r) => setTimeout(r, 30));

      // Brief non-bot blip — schedules a debounced cancel.
      dispatcher.dispatch(MEETING_ID, speakerChange(HUMAN_SPEAKER_ID));
      expect(watcher._hasPendingCancel()).toBe(true);

      // Floor returns to the bot well within the 250ms debounce.
      await new Promise((r) => setTimeout(r, 80));
      dispatcher.dispatch(
        MEETING_ID,
        speakerChange(BOT_PARTICIPANT_ID, "Aria"),
      );

      // The pending cancel must have been cleared by the return-to-bot
      // event — no debounce timer should still be queued.
      expect(watcher._hasPendingCancel()).toBe(false);

      // Wait long enough for what *would* have been the cancel deadline
      // to pass, then assert nothing fired.
      await new Promise((r) => setTimeout(r, BARGE_IN_DEBOUNCE_MS + 100));
      expect(cancelSpy).toHaveBeenCalledTimes(0);
      expect(fakeBot.deletes).toHaveLength(0);

      // Let the speak finish naturally so we leave the test in a clean
      // state. The completion may resolve as 'completed' or, if the
      // POST hasn't fully drained yet, may still be in flight when the
      // afterEach tears down the bot — both are fine.
      await result.completion.catch(() => {});

      const ended = (await captured.waitFor(
        (m) =>
          m.type === "meet.speaking_ended" &&
          (m as { streamId: string }).streamId === "stream-cough",
      )) as { reason: string };
      // Must have ended naturally (not cancelled / not error).
      expect(ended.reason).toBe("completed");
    } finally {
      captured.dispose();
      watcher.stop();
    }
  });
});
