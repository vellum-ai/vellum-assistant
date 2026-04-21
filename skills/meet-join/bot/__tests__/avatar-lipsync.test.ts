/**
 * Lip-sync alignment tests for the TalkingHead.js renderer.
 *
 * The renderer is responsible for buffering inbound viseme events and
 * only forwarding them to the extension when the audio-playback clock
 * catches up to each viseme's declared timestamp. This prevents visible
 * drift when the network between the daemon and the bot delays visemes:
 * a viseme that arrives 100ms ahead of its corresponding audio is held
 * until the audio actually plays out of `bot_out`, then released.
 *
 * These tests exercise that behavior end-to-end against the real
 * {@link TalkingHeadRenderer} + real {@link startAudioPlayback}
 * pipeline (the pacat subprocess is a shim), with a fake
 * {@link AvatarNativeMessagingSender} capturing the downstream
 * `avatar.push_viseme` frames the extension would have received. We
 * drive the audio-playback handle with deterministic byte writes +
 * a controllable `now()` clock so the playback-timestamp stream is
 * fully observable and the test is not flaky on machine load.
 *
 * Coverage:
 *   - Visemes that arrive AHEAD of audio are held until the
 *     audio-playback timestamp catches up, then flushed in order.
 *   - Visemes that arrive LATE (after audio already passed their
 *     declared time) are flushed immediately — no "ghost" delay.
 *   - The renderer's `currentPlaybackTimestamp` is monotonic; a
 *     stale/out-of-order timestamp notification is ignored rather
 *     than rewinding the clock.
 *   - A `stop()` clears the buffer so visemes queued for a
 *     terminated session do not leak into a later one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  BotAvatarPushVisemeCommand,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import type { AvatarNativeMessagingSender } from "../src/media/avatar/index.js";
import { TalkingHeadRenderer } from "../src/media/avatar/talking-head/renderer.js";
import {
  __resetForTests as resetAudioPlayback,
  startAudioPlayback,
  stopAudioPlayback,
  type PacatWritable,
  type SpawnedPacat,
} from "../src/media/audio-playback.js";

// ---------------- helpers ------------------------------------------------

type BotAvatarMsg =
  | BotAvatarPushVisemeCommand
  | { type: "avatar.start"; targetFps?: number; modelUrl?: string }
  | { type: "avatar.stop" };

/**
 * In-memory fake of the native-messaging surface the renderer drives.
 * Captures every bot→extension message sent and exposes an `emit`
 * helper so tests can simulate the extension's inbound frames.
 */
class FakeNativeMessaging implements AvatarNativeMessagingSender {
  readonly sent: BotAvatarMsg[] = [];
  private listeners: Array<(msg: ExtensionToBotMessage) => void> = [];

  sendToExtension = (msg: BotAvatarMsg): void => {
    this.sent.push(msg);
  };

  onExtensionMessage = (cb: (msg: ExtensionToBotMessage) => void): void => {
    this.listeners.push(cb);
  };

  emit(msg: ExtensionToBotMessage): void {
    for (const cb of this.listeners.slice()) cb(msg);
  }

  pushVisemes(): BotAvatarPushVisemeCommand[] {
    return this.sent.filter(
      (m): m is BotAvatarPushVisemeCommand => m.type === "avatar.push_viseme",
    );
  }
}

/**
 * Minimal pacat shim — stdin writes append to a buffer, `kill()`
 * resolves the `exited` promise. The test drives the handle with raw
 * byte writes and observes which visemes the renderer flushes at each
 * playback-timestamp emission.
 */
function makePacatShim(): {
  proc: SpawnedPacat;
  bytesWritten: () => number;
} {
  let written = 0;
  const stdin: PacatWritable = {
    write(chunk: Uint8Array): number {
      written += chunk.length;
      return chunk.length;
    },
    async end() {
      /* no-op; kill() controls lifetime */
    },
  };
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  const proc: SpawnedPacat = {
    stdin,
    exited,
    kill() {
      resolveExited(0);
    },
  };
  return { proc, bytesWritten: () => written };
}

/**
 * Drive the bot's renderer so it is started and ready to accept
 * visemes. Encapsulates the "send avatar.start, receive avatar.started
 * ack, await the start promise" handshake every test needs.
 */
async function startRenderer(
  nativeMessaging: FakeNativeMessaging,
): Promise<TalkingHeadRenderer> {
  const r = new TalkingHeadRenderer({
    nativeMessaging,
    startedAckTimeoutMs: 500,
  });
  const startPromise = r.start();
  nativeMessaging.emit({ type: "avatar.started" });
  await startPromise;
  return r;
}

// ---------------- tests --------------------------------------------------

describe("TalkingHead renderer lip-sync alignment", () => {
  beforeEach(() => {
    resetAudioPlayback();
  });

  afterEach(async () => {
    await stopAudioPlayback();
    resetAudioPlayback();
  });

  test("visemes arriving 100ms before audio are held until playback catches up", async () => {
    // The full pipeline under test: viseme events stream in 100 ms
    // ahead of the corresponding audio, the bot queues PCM into the
    // audio-playback handle, and the handle's playback-timestamp
    // stream drives the renderer's flush cadence. The playback clock
    // is utterance-relative and seeded to 0 on `startAudioPlayback`,
    // advancing by `byteCount / bytesPerMs` on every non-empty write —
    // so deterministic PCM writes produce deterministic playback
    // timestamps without any wall-clock dependence.

    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);

    const shim = makePacatShim();
    const handle = startAudioPlayback({
      spawn: () => shim.proc,
    });

    // Wire the playback-timestamp stream into the renderer. This is
    // exactly what the bot's HTTP server does in production when an
    // avatar renderer is active alongside an in-flight /play_audio
    // stream.
    const unsubscribe = handle.onPlaybackTimestamp((ts) => {
      renderer.notifyPlaybackTimestamp(ts);
    });

    // Capture every viseme the renderer forwards to the extension.
    // A perfectly aligned pipeline emits each viseme at the moment
    // audio for that viseme's utterance-relative timestamp actually
    // plays out — NOT at the moment the viseme was pushed into the
    // renderer.
    const flushed: string[] = [];
    nativeMessaging.sendToExtension = (msg: BotAvatarMsg): void => {
      if (msg.type === "avatar.push_viseme") {
        flushed.push(msg.phoneme);
      }
    };

    // Step 1: visemes arrive ahead of audio. The renderer MUST hold
    // them. Push three visemes with timestamps 100, 200, 300 (ms).
    // They arrive before any PCM is written — 100 ms before their
    // declared audio timestamp, exactly the drift scenario from the
    // PR description.
    renderer.pushViseme({ phoneme: "ah", weight: 0.8, timestamp: 100 });
    renderer.pushViseme({ phoneme: "ee", weight: 0.6, timestamp: 200 });
    renderer.pushViseme({ phoneme: "oh", weight: 0.4, timestamp: 300 });

    // None of the visemes should be forwarded yet — the audio-
    // playback clock is still at utterance-offset 0 and none of them
    // has come due. This is the whole point of the buffering: the
    // extension must not see the visemes ahead of the audio.
    expect(flushed).toEqual([]);

    // Step 2: audio starts flowing. Queue 100 ms worth of PCM. At
    // 48000 Hz mono s16le that's 9600 bytes (96 bytes/ms). Writing
    // 9600 bytes advances the utterance-relative playback clock to
    // 100 ms — the first viseme comes due.
    const BYTES_PER_MS = handle.bytesPerMs;
    const chunk100ms = new Uint8Array(100 * BYTES_PER_MS);
    await handle.write(chunk100ms);

    // The "ah" viseme (timestamp 100) should now have been forwarded
    // because the playback clock advanced to exactly 100. The other
    // two remain buffered.
    expect(flushed).toEqual(["ah"]);

    // Step 3: queue another 150 ms of audio. The clock advances to
    // 100 + 150 = 250 ms. Viseme "ee" (t=200) comes due; "oh" (t=300)
    // stays.
    const chunk150ms = new Uint8Array(150 * BYTES_PER_MS);
    await handle.write(chunk150ms);

    expect(flushed).toEqual(["ah", "ee"]);

    // Step 4: queue the remaining 50 ms — clock reaches 300 ms, the
    // last viseme drains.
    const chunk50ms = new Uint8Array(50 * BYTES_PER_MS);
    await handle.write(chunk50ms);

    expect(flushed).toEqual(["ah", "ee", "oh"]);

    unsubscribe();
  });

  test("late visemes (timestamp < current playback clock) flush immediately", async () => {
    // The viseme-arrival-time drift can go either way: late visemes
    // (e.g. a burst after network congestion) should NOT be
    // additionally delayed. Once a viseme's timestamp is already in
    // the past relative to the playback clock, the renderer must
    // release it as soon as pushViseme is called.
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);
    const shim = makePacatShim();
    const handle = startAudioPlayback({
      spawn: () => shim.proc,
    });
    const unsubscribe = handle.onPlaybackTimestamp((ts) => {
      renderer.notifyPlaybackTimestamp(ts);
    });

    // Drive audio forward to 500 ms.
    const BYTES_PER_MS = handle.bytesPerMs;
    await handle.write(new Uint8Array(500 * BYTES_PER_MS));

    const before = nativeMessaging.pushVisemes().length;

    // Push a viseme declared at t=100 — 400 ms in the past. Should
    // flush immediately with no further audio needed.
    renderer.pushViseme({ phoneme: "p", weight: 0.2, timestamp: 100 });

    const after = nativeMessaging.pushVisemes();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.phoneme).toBe("p");

    unsubscribe();
  });

  test("notifyPlaybackTimestamp is monotonic — a stale notification does not rewind", async () => {
    // Regression guard: if an observer accidentally forwards an
    // older timestamp (e.g. from a stale `setInterval` closure), the
    // renderer must not rewind its clock. A subsequent push of a
    // viseme whose timestamp is between the old and new clock values
    // must still be held.
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);

    renderer.notifyPlaybackTimestamp(1_000);
    renderer.notifyPlaybackTimestamp(500); // stale — must be ignored

    renderer.pushViseme({ phoneme: "m", weight: 0.3, timestamp: 700 });

    // The clock was never actually rewound, so 700 <= 1000 and the
    // viseme flushes immediately.
    const pushed = nativeMessaging.pushVisemes();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.phoneme).toBe("m");

    // Push a viseme at t=1500 — still in the future relative to the
    // clock (1000), so it must stay buffered.
    renderer.pushViseme({ phoneme: "k", weight: 0.3, timestamp: 1500 });
    expect(nativeMessaging.pushVisemes()).toHaveLength(1);

    // Advance past 1500 and confirm it flushes.
    renderer.notifyPlaybackTimestamp(2_000);
    const all = nativeMessaging.pushVisemes();
    expect(all).toHaveLength(2);
    expect(all[1]!.phoneme).toBe("k");
  });

  test("stop() clears the viseme buffer; a later clock advance does not leak stale events", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);

    // Buffer a viseme the clock hasn't reached yet.
    renderer.pushViseme({ phoneme: "t", weight: 0.3, timestamp: 10_000 });
    expect(nativeMessaging.pushVisemes()).toHaveLength(0);

    await renderer.stop();

    // Even if some late caller advances the clock well past the
    // buffered timestamp, the stopped renderer must not emit.
    renderer.notifyPlaybackTimestamp(1_000_000);

    expect(nativeMessaging.pushVisemes()).toHaveLength(0);
  });

  test("resetPlaybackTimestamp rewinds the clock and drops stale buffered visemes so the next utterance's visemes are not flushed immediately", async () => {
    // Regression guard for the multi-utterance accumulation bug: the
    // `/play_audio` handle is a module-level singleton, and the daemon
    // stamps VisemeEvent.timestamp as ms-from-start-of-THIS-utterance
    // (so each utterance resets to 0). Without a per-utterance clock
    // reset the renderer's `currentPlaybackTimestamp` would sit at the
    // end-of-prior-utterance value (say 550 ms), and every viseme from
    // utterance 2 would satisfy `timestamp <= 550` and flush
    // immediately — defeating the buffering that makes this alignment
    // work in the first place.
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);

    // Utterance 1: advance the clock to 550 ms. This models having
    // pushed ~550 ms of PCM for the first utterance.
    renderer.notifyPlaybackTimestamp(550);

    // Leave one viseme from utterance 1 still buffered in the future
    // (e.g. a late-declared viseme whose audio had not yet played).
    // It belongs to utterance 1 and must NOT leak into utterance 2.
    renderer.pushViseme({ phoneme: "stale", weight: 0.1, timestamp: 900 });
    expect(nativeMessaging.pushVisemes()).toHaveLength(0);

    // Simulate the HTTP server starting a fresh /play_audio POST: it
    // rewinds the renderer's clock in lockstep with the handle's
    // `resetPlaybackClock()`.
    expect(typeof renderer.resetPlaybackTimestamp).toBe("function");
    renderer.resetPlaybackTimestamp!();

    // Utterance 2's visemes arrive with ts values restarting at 0.
    // They must be buffered — the clock was rewound past them — not
    // flushed immediately.
    renderer.pushViseme({ phoneme: "a", weight: 0.2, timestamp: 100 });
    renderer.pushViseme({ phoneme: "b", weight: 0.3, timestamp: 200 });
    expect(nativeMessaging.pushVisemes()).toHaveLength(0);

    // Advance the clock into utterance 2's range. `a` (t=100) should
    // flush; `b` (t=200) stays buffered. The stale viseme from
    // utterance 1 must NOT surface.
    renderer.notifyPlaybackTimestamp(100);
    let pushed = nativeMessaging.pushVisemes();
    expect(pushed.map((v) => v.phoneme)).toEqual(["a"]);

    renderer.notifyPlaybackTimestamp(200);
    pushed = nativeMessaging.pushVisemes();
    expect(pushed.map((v) => v.phoneme)).toEqual(["a", "b"]);

    // Push a very-large timestamp to confirm the stale utterance-1
    // viseme (t=900) was dropped by the reset, not just hidden.
    renderer.notifyPlaybackTimestamp(10_000);
    pushed = nativeMessaging.pushVisemes();
    expect(pushed.map((v) => v.phoneme)).toEqual(["a", "b"]);
  });

  test("visemes with identical timestamps are forwarded in arrival order", async () => {
    // ElevenLabs' viseme stream can legitimately produce back-to-back
    // events with the same millisecond timestamp. The buffer drain
    // order must follow arrival order, not a secondary sort key
    // (which would require a stable sort and introduce subtle
    // ordering bugs in the extension).
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = await startRenderer(nativeMessaging);

    renderer.pushViseme({ phoneme: "a", weight: 0.1, timestamp: 100 });
    renderer.pushViseme({ phoneme: "b", weight: 0.2, timestamp: 100 });
    renderer.pushViseme({ phoneme: "c", weight: 0.3, timestamp: 100 });
    expect(nativeMessaging.pushVisemes()).toHaveLength(0);

    renderer.notifyPlaybackTimestamp(100);
    const pushed = nativeMessaging.pushVisemes();
    expect(pushed.map((v) => v.phoneme)).toEqual(["a", "b", "c"]);
  });
});
