/**
 * Avatar renderer interface for the meet-bot's camera-feed pipeline.
 *
 * The Phase 4 avatar stack is intentionally pluggable: concrete renderers
 * (WebGL/TalkingHead.js, hosted WebRTC backends like Simli/HeyGen/Tavus, GPU
 * sidecars like SadTalker/MuseTalk) all implement the `AvatarRenderer`
 * interface in this file, and the daemon picks one at runtime via config
 * (`services.meet.avatar.renderer`). That means the surrounding
 * infrastructure — v4l2loopback device passthrough, Chrome camera-flag
 * wiring, TTS-driven lip-sync input — only has to target this interface;
 * adding a new backend is a single PR that implements the interface and
 * registers itself with the factory.
 *
 * This module only exports shapes. Concrete renderers and the factory land
 * in later PRs (PR 5 and the PR 5a/b/c/d renderer-specific follow-ups).
 */
export type Y4MFrame = {
  /** Raw Y4M frame bytes ready to be written to `/dev/video10`. */
  bytes: Uint8Array;
  /**
   * Monotonic timestamp (ms) of when this frame should ideally appear on
   * the Meet camera feed. Downstream consumers use this to align frames
   * with the audio stream; the bot's v4l2 writer currently does not gate
   * on this value and writes frames as they arrive.
   */
  timestamp: number;
  width: number;
  height: number;
};

export type VisemeEvent = {
  /**
   * Phoneme or viseme identifier. Providers that emit viseme/alignment
   * metadata use their native label (e.g. ElevenLabs Turbo alignment);
   * the amplitude-envelope fallback uses the sentinel `"amp"`.
   */
  phoneme: string;
  /**
   * Mouth-openness weight in `[0, 1]`, where 0 is fully closed and 1 is
   * fully open. Amplitude fallbacks produce a coarsely-quantized value
   * derived from RMS per 50ms window; phoneme-aware providers emit the
   * provider's own mouth-shape scalar rescaled to this range.
   */
  weight: number;
  /** Monotonic timestamp (ms) used to align the viseme with the audio. */
  timestamp: number;
  /**
   * Optional — the `stream_id` of the `/play_audio` POST this viseme
   * belongs to. The daemon stamps every viseme it emits with the same
   * id it uses for the paired `/play_audio?stream_id=` call so the bot
   * can distinguish prior-utterance leftovers from new-utterance events
   * that raced ahead of their POST.
   *
   * Only consumed by `resetPlaybackTimestamp` — a new POST preserves
   * same-streamId buffered visemes and drops everything else. A viseme
   * with `streamId === undefined` predates this tagging (an older
   * daemon) and is treated as "belongs to no current stream" — i.e.
   * dropped on reset, matching the original clear-all behavior.
   */
  streamId?: string;
  /**
   * Optional — the bridge-internal utterance id that uniquely identifies
   * one `MeetTtsBridge.speak()` call. Distinct from `streamId` because
   * `streamId` can legally be reused across speak() calls (the bridge
   * accepts caller-supplied ids and only rejects duplicates while a
   * stream is concurrently active), so a leftover viseme from a
   * cancelled prior utterance and an early-arriving viseme from the
   * reused-streamId successor would both match the new POST's
   * `streamId` and survive `resetPlaybackTimestamp` — leaking stale
   * mouth shapes into the new utterance. The bridge mints a fresh
   * `utteranceId` per speak() call so the renderer can require both
   * `streamId` AND `utteranceId` to match before preserving an event,
   * which is the minimum signal needed to disambiguate the two cases.
   */
  utteranceId?: string;
};

/**
 * Declares which input streams a renderer actually consumes so the daemon
 * can skip pushing unused data.
 *
 * - `needsVisemes: true` — the renderer lip-syncs from the viseme/amplitude
 *   stream emitted by `MeetTtsBridge`; WebGL/TalkingHead-style renderers
 *   set this to `true`.
 * - `needsAudio: true` — the renderer needs the raw PCM stream (e.g. a
 *   hosted WebRTC backend that generates motion server-side from audio,
 *   or a GPU sidecar that takes `(reference_image + audio)`). Most
 *   viseme-driven renderers set this to `false`.
 *
 * Renderers that want neither (e.g. a static/noop renderer) may set both
 * to `false`; `pushAudio` and `pushViseme` are still always callable but
 * become no-ops for that renderer.
 */
export type AvatarCapabilities = {
  needsVisemes: boolean;
  needsAudio: boolean;
};

/**
 * Pluggable avatar renderer. Implementations own their own state, spawn
 * whatever subprocesses or tabs they need inside `start()`, and push
 * rendered Y4M frames out through `onFrame` subscribers.
 *
 * Lifecycle:
 * - `start()` is called once per renderer lifecycle. Implementations should
 *   be tolerant of (but not required to support) a second call on the same
 *   instance — prefer constructing a fresh renderer after `stop()` if a
 *   restart is needed.
 * - `stop()` must be idempotent: repeated calls settle without throwing.
 * - `pushAudio` / `pushViseme` are always callable but are no-ops when
 *   the corresponding capability is `false`. Callers need not branch on
 *   `capabilities` before pushing — the renderer drops data it doesn't
 *   consume — but the daemon is encouraged to check capabilities before
 *   doing expensive work to produce audio or visemes that would be
 *   discarded.
 * - `onFrame` returns an unsubscribe function. Calling the returned
 *   function removes the subscriber; calling it more than once is a
 *   no-op.
 */
export interface AvatarRenderer {
  /** Stable renderer identifier (e.g. `"talkinghead"`, `"simli"`, `"noop"`). */
  readonly id: string;
  readonly capabilities: AvatarCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Push a PCM chunk into the renderer. No-op when
   * `capabilities.needsAudio` is `false`. `ts` is a monotonic timestamp
   * (ms) used for downstream alignment.
   */
  pushAudio(pcm: Uint8Array, ts: number): void;
  /**
   * Push a viseme/amplitude event into the renderer. No-op when
   * `capabilities.needsVisemes` is `false`.
   */
  pushViseme(event: VisemeEvent): void;
  /**
   * Subscribe to rendered Y4M frames. Returns an unsubscribe function;
   * call it to remove the subscriber. Subsequent calls to the returned
   * unsubscribe function are no-ops.
   */
  onFrame(cb: (frame: Y4MFrame) => void): () => void;
  /**
   * Optional — advance the renderer's internal audio-playback clock.
   * The bot's HTTP server wires the audio-playback handle's
   * `onPlaybackTimestamp` stream into this method when both a
   * `/play_audio` stream and a viseme-driven renderer are active, so
   * visemes can be emitted at the moment their corresponding audio
   * actually plays rather than when the viseme arrived over the wire.
   *
   * Only viseme-driven renderers (TalkingHead.js) need to implement
   * this. Hosted renderers (Simli/HeyGen/Tavus) and GPU sidecars
   * (SadTalker/MuseTalk) do audio-to-motion timing server-side, so
   * leaving this method undefined is the correct behavior — the HTTP
   * server detects the missing method and skips the wiring entirely
   * for those backends.
   */
  notifyPlaybackTimestamp?(ts: number): void;
  /**
   * Optional — reset the renderer's internal audio-playback clock back
   * to its "no audio queued yet" state. Called by the HTTP server at
   * the start of every new `/play_audio` stream, in lockstep with the
   * audio-playback handle's `resetPlaybackClock()`. Without this reset
   * the renderer's monotonic clock would sit at the end-of-prior-
   * utterance timestamp, and every viseme from the next utterance
   * (stamped as ms-from-THAT-utterance-start, i.e. restarting at 0)
   * would satisfy `visemeTs <= currentPlaybackTimestamp` and flush
   * immediately on arrival — the exact bug `notifyPlaybackTimestamp`
   * exists to prevent.
   *
   * Implementations should drop buffered visemes that belonged to the
   * prior utterance so they cannot leak into the fresh stream, but
   * must preserve visemes tagged with the incoming utterance's
   * identifiers — the daemon fires synthesis concurrently with the
   * `/play_audio` POST, so some events from the incoming utterance can
   * land BEFORE the POST that triggers this reset.
   *
   * `incomingStreamId` is the `stream_id` of the new POST.
   * `incomingUtteranceId` is the bridge-internal utterance id of the
   * new POST. Visemes whose `streamId` AND `utteranceId` both match
   * are preserved. Matching on `streamId` alone is unsafe because
   * caller-supplied stream ids can be reused across speak() calls,
   * which would let prior-utterance leftovers tagged with the same
   * `streamId` slip through. Visemes with mismatched ids — or no
   * `streamId`/`utteranceId` at all (the pre-tagging case) — are
   * dropped.
   */
  resetPlaybackTimestamp?(
    incomingStreamId?: string,
    incomingUtteranceId?: string,
  ): void;
}

/**
 * Thrown by renderer constructors or `start()` when preconditions aren't
 * met — missing credentials, missing asset file, required GPU absent, etc.
 * Callers (the factory in PR 5) catch this specifically so the meeting
 * can degrade gracefully (fall through to a noop/static renderer) instead
 * of crashing.
 */
export class AvatarRendererUnavailableError extends Error {
  readonly rendererId: string;
  readonly reason: string;

  constructor(rendererId: string, reason: string) {
    super(`avatar renderer "${rendererId}" unavailable: ${reason}`);
    this.name = "AvatarRendererUnavailableError";
    this.rendererId = rendererId;
    this.reason = reason;
  }
}
