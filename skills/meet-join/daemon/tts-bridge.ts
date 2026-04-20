/**
 * MeetTtsBridge — streams synthesized speech from the configured TTS
 * provider into the Meet-bot's `/play_audio` endpoint.
 *
 * High-level flow per `speak()` call:
 *
 *   1. Allocate an opaque `streamId` (UUID v4).
 *   2. Resolve the configured TTS provider via the injected factory and
 *      invoke `provider.synthesizeStream({ text, voiceId, … }, onChunk)`.
 *      The provider emits audio in its own native format (mp3, wav, pcm at
 *      various sample rates) — the bridge does not assume 48 kHz s16le.
 *   3. Spawn a single ffmpeg child per call that transcodes whatever the
 *      provider emits into the bot's expected contract: raw 48 kHz / mono /
 *      16-bit signed little-endian PCM. Provider chunks are written into
 *      ffmpeg's stdin; ffmpeg's stdout is the body stream consumed by the
 *      outbound HTTP POST.
 *   4. POST `ffmpeg.stdout` to `${botUrl}/play_audio?stream_id=${streamId}`
 *      with `Content-Type: application/octet-stream` using chunked transfer.
 *      Because Node/undici require it for streamed upload bodies, the fetch
 *      is called with `duplex: "half"`.
 *   5. On abort (via `cancel(streamId)`): abort the outbound HTTP request,
 *      kill the ffmpeg child, and best-effort hit
 *      `DELETE /play_audio/${streamId}` so the bot can flush any buffered
 *      audio and play silence in its place.
 *
 * The bridge intentionally does NOT reach into the `assistant/src/tts/`
 * module beyond consuming the {@link TtsProvider} interface — it accepts
 * a provider factory via constructor injection so the existing abstraction
 * stays a black box and tests can swap in a canned provider without
 * touching the registry.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

import { getLogger } from "../../../assistant/src/util/logger.js";
import type {
  TtsAlignmentEvent,
  TtsProvider,
  TtsSynthesisRequest,
} from "../../../assistant/src/tts/types.js";

const log = getLogger("meet-tts-bridge");

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/**
 * Target audio format the bot's `/play_audio` endpoint expects on the wire.
 * Matches the Meet audio pipeline: 48 kHz, mono, 16-bit signed little-endian
 * PCM. See PR 1 (bot endpoint) for the contract on the other side.
 */
export const BOT_AUDIO_SAMPLE_RATE_HZ = 48_000;
export const BOT_AUDIO_CHANNELS = 1;
export const BOT_AUDIO_SAMPLE_BITS = 16;
export const BOT_AUDIO_ENCODING = "pcm_s16le";

/**
 * Timeout for the best-effort `DELETE /play_audio/<streamId>` issued during
 * cancel. The DELETE is cosmetic (the POST is already aborted, so the bot
 * sees EOF), but we don't want a hung DELETE to block the cancel path
 * indefinitely.
 */
export const CANCEL_DELETE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Lip-sync tap — viseme channel and amplitude fallback
// ---------------------------------------------------------------------------

/**
 * Window over which the amplitude-envelope fallback computes RMS. Chosen
 * to match the ~50ms cadence the avatar consumer expects (PR 4 of the
 * meet-phase-4 plan). 50ms at 48 kHz mono s16le = 2400 samples = 4800 bytes.
 */
export const AMPLITUDE_WINDOW_MS = 50;

/** Sample rate used for the amplitude fallback — matches the bot wire format. */
const AMPLITUDE_SAMPLE_RATE_HZ = BOT_AUDIO_SAMPLE_RATE_HZ;

/** Bytes per sample for the ffmpeg output (s16le mono = 2 bytes per sample). */
const AMPLITUDE_BYTES_PER_SAMPLE =
  (BOT_AUDIO_SAMPLE_BITS / 8) * BOT_AUDIO_CHANNELS;

/** Samples per amplitude window. */
const AMPLITUDE_SAMPLES_PER_WINDOW = Math.floor(
  (AMPLITUDE_SAMPLE_RATE_HZ * AMPLITUDE_WINDOW_MS) / 1000,
);

/** Bytes per amplitude window. */
const AMPLITUDE_BYTES_PER_WINDOW =
  AMPLITUDE_SAMPLES_PER_WINDOW * AMPLITUDE_BYTES_PER_SAMPLE;

/**
 * Maximum absolute sample value for 16-bit signed audio — used to normalize
 * the RMS into a `[0, 1]` weight for downstream blendshape mapping.
 */
const AMPLITUDE_MAX_SAMPLE = 32768;

/**
 * Viseme event emitted from the bridge's `onViseme` channel.
 *
 * TODO: import from `skills/meet-join/bot/src/media/avatar/types.ts` once
 * PR 1 of the meet-phase-4 plan lands on `main`. The shape is identical
 * to the `VisemeEvent` declared there — duplicated here to unblock this
 * PR shipping in Wave 1 alongside PR 1.
 */
export interface VisemeEvent {
  /**
   * Phoneme or viseme label. Provider-backed events pass through whatever
   * label the provider emitted (e.g. IPA phoneme, ElevenLabs character).
   * Amplitude-fallback events emit the literal string `"amp"`.
   */
  phoneme: string;
  /** Normalized intensity in the range [0, 1]. */
  weight: number;
  /** Milliseconds from the start of the synthesized utterance. */
  timestamp: number;
}

/**
 * Subscriber callback shape for {@link MeetTtsBridge.onViseme}. Called
 * synchronously from the bridge's event loop — subscribers must not
 * block (enqueue work, do not await).
 */
export type VisemeListener = (event: VisemeEvent) => void;

/** Clamp a numeric weight into `[0, 1]` — tolerates slightly-out-of-range providers. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * ffmpeg arguments that read whatever container-wrapped format the TTS
 * provider emits on stdin and write raw 48 kHz / mono / s16le PCM on
 * stdout. The decoder is format-agnostic (no `-f` on input) so the same
 * pipeline accepts mp3, wav, or opus without branching — ffmpeg sniffs
 * the container and picks the right decoder.
 *
 * Why the explicit output `-ar 48000` matters:
 *
 *   Provider voices ship at a variety of native sample rates — ElevenLabs
 *   mp3 at 22.05 kHz or 44.1 kHz, Fish Audio wav at 44.1 kHz, Deepgram
 *   opus at 48 kHz, etc. The bot's `/play_audio` endpoint feeds its body
 *   directly into `pacat --playback --rate=48000 --channels=1 --format=s16le`,
 *   so any rate mismatch would render as chipmunk/slowed audio in the
 *   meeting. ffmpeg resamples to the output `-ar` (via libswresample), and
 *   `-ac 1` downmixes to mono so stereo voices don't get interleaved-
 *   sample-as-time-domain corruption when pacat reads them as mono.
 *
 *   Keeping `-ar 48000 -ac 1` on the OUTPUT side (post `-i`) is what makes
 *   the resample/downmix happen — if these flags were on the input side,
 *   they would be interpreted as "assume the input is already this rate"
 *   (useful only for headerless raw PCM), which is exactly the chipmunk
 *   bug we're guarding against.
 */
export const FFMPEG_TRANSCODE_ARGS = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  "pipe:0",
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "-ar",
  String(BOT_AUDIO_SAMPLE_RATE_HZ),
  "-ac",
  String(BOT_AUDIO_CHANNELS),
  "pipe:1",
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for a single `speak` call. */
export interface SpeakInput {
  /** Pre-sanitized text to synthesize and play. */
  text: string;
  /** Optional provider-specific voice identifier. */
  voice?: string;
  /**
   * Optional caller-supplied stream id. Useful for tests and for callers
   * that want to tag outbound audio with their own tracking id. When
   * omitted, a random UUID is allocated.
   */
  streamId?: string;
}

/** Result returned from a successful `speak` call initiation. */
export interface SpeakResult {
  /** Identifier the bot uses to associate this audio stream. */
  streamId: string;
  /**
   * Promise that resolves when the outbound HTTP POST to the bot settles
   * (either on the bot's 2xx response or after a cancel/error teardown).
   * Rejects when the bot returns a non-2xx status that isn't caused by a
   * caller-initiated cancel. Callers can await this to know when playback
   * has ended; most callers fire-and-forget.
   */
  completion: Promise<void>;
}

/**
 * Narrow fetch-like signature the bridge actually uses. Matches the global
 * `fetch` but keeps the dependency explicit for tests.
 */
export type FetchFn = (
  input: string | URL,
  init?: RequestInit & { duplex?: "half" },
) => Promise<Response>;

/** Spawn primitive — `node:child_process#spawn` by default. */
export type SpawnFn = typeof nodeSpawn;

export interface MeetTtsBridgeDeps {
  /**
   * Factory returning the configured {@link TtsProvider}. Called once per
   * `speak` so config changes propagate on the next invocation without the
   * bridge needing to re-subscribe.
   */
  providerFactory: () => TtsProvider | Promise<TtsProvider>;
  /** Override the fetch used for outbound HTTP (tests). */
  fetch?: FetchFn;
  /** Override the spawn used for the ffmpeg transcode (tests). */
  spawn?: SpawnFn;
  /** Override the UUID generator used for streamId allocation (tests). */
  newStreamId?: () => string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type MeetTtsErrorCode =
  | "MEET_TTS_PROVIDER_UNAVAILABLE"
  | "MEET_TTS_FFMPEG_UNAVAILABLE"
  | "MEET_TTS_BOT_REJECTED"
  | "MEET_TTS_BOT_UNREACHABLE";

export class MeetTtsError extends Error {
  readonly code: MeetTtsErrorCode;
  readonly status?: number;

  constructor(code: MeetTtsErrorCode, message: string, status?: number) {
    super(message);
    this.name = "MeetTtsError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Thrown from {@link MeetTtsBridge} when an in-flight speak is cancelled
 * via {@link MeetTtsBridge.cancel} or {@link MeetTtsBridge.cancelAll}.
 *
 * The session manager's `speak()` classifier keys on this class (via
 * `err instanceof MeetTtsCancelledError` or `err.code === "MEET_TTS_CANCELLED"`)
 * so `meet.speaking_ended` can publish `reason: "cancelled"` for caller-
 * initiated and barge-in cancels, distinct from `reason: "completed"` for
 * natural finishes and `reason: "error"` for genuine upstream failures.
 */
export class MeetTtsCancelledError extends Error {
  readonly code = "MEET_TTS_CANCELLED" as const;

  constructor(message = "cancelled") {
    super(message);
    this.name = "MeetTtsCancelledError";
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ActiveStream {
  abort: AbortController;
  /** Resolves when the POST settles and teardown is complete. */
  settled: Promise<void>;
}

/** Cached result of the one-shot `ffmpeg -version` probe. */
type FfmpegProbeResult =
  | { available: true }
  | { available: false; reason: string };

/**
 * Constructor input identifying which bot this bridge talks to.
 */
export interface MeetTtsBridgeArgs {
  meetingId: string;
  /** Base URL of the bot's control API, e.g. `http://127.0.0.1:49200`. */
  botBaseUrl: string;
  /** Per-meeting bearer token minted by the session manager. */
  botApiToken: string;
}

export class MeetTtsBridge {
  readonly meetingId: string;
  readonly botBaseUrl: string;

  private readonly botApiToken: string;
  private readonly deps: Required<MeetTtsBridgeDeps>;
  private readonly streams = new Map<string, ActiveStream>();
  /**
   * Subscribers to the per-bridge viseme channel. Populated via
   * {@link MeetTtsBridge.onViseme}. Events from both the provider
   * alignment path and the RMS-amplitude fallback fan out to every
   * subscriber. The set is shared across every `speak` call on this
   * bridge — the lip-sync forwarder subscribes once at construction,
   * not per utterance.
   */
  private readonly visemeListeners = new Set<VisemeListener>();
  /**
   * Memoized `ffmpeg -version` probe. Cached after the first `speak` call so
   * subsequent speaks re-use the result without re-spawning ffmpeg. Resolves
   * with `{ available: true }` when ffmpeg is on PATH and exits (regardless
   * of exit code — even `-version` writing banner then exiting counts as
   * "ffmpeg is runnable"), and `{ available: false, reason }` when spawn
   * fails with ENOENT or a similar "binary missing" error.
   */
  private ffmpegProbe: Promise<FfmpegProbeResult> | null = null;

  constructor(args: MeetTtsBridgeArgs, deps: MeetTtsBridgeDeps) {
    if (!args.meetingId) {
      throw new Error("MeetTtsBridge: meetingId is required");
    }
    if (!args.botBaseUrl) {
      throw new Error("MeetTtsBridge: botBaseUrl is required");
    }
    if (!args.botApiToken) {
      throw new Error("MeetTtsBridge: botApiToken is required");
    }
    if (!deps?.providerFactory) {
      throw new Error("MeetTtsBridge: providerFactory is required");
    }
    this.meetingId = args.meetingId;
    this.botBaseUrl = args.botBaseUrl.replace(/\/+$/, "");
    this.botApiToken = args.botApiToken;
    this.deps = {
      providerFactory: deps.providerFactory,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init as RequestInit)),
      spawn: deps.spawn ?? nodeSpawn,
      newStreamId: deps.newStreamId ?? (() => randomUUID()),
    };
  }

  /**
   * Start streaming a synthesized utterance to the bot. Allocates (or uses
   * the caller-supplied) `streamId`, opens the provider's streaming
   * synthesis call, transcodes on the fly via ffmpeg, and POSTs the result
   * to the bot. Returns the streamId immediately; the POST runs in the
   * background and its completion can be awaited via `result.completion`.
   */
  async speak(input: SpeakInput): Promise<SpeakResult> {
    const streamId = input.streamId ?? this.deps.newStreamId();
    if (this.streams.has(streamId)) {
      throw new Error(
        `MeetTtsBridge: streamId ${streamId} is already active for meeting ${this.meetingId}`,
      );
    }

    // Pre-flight: verify ffmpeg is on PATH before we allocate any streams.
    // The probe result is memoized on the bridge instance, so this only
    // spawns ffmpeg once per bridge lifetime on the happy path. If ffmpeg
    // was uninstalled between bridges, each new bridge re-probes.
    const probe = await this.ensureFfmpegAvailable();
    if (!probe.available) {
      throw new MeetTtsError(
        "MEET_TTS_FFMPEG_UNAVAILABLE",
        `ffmpeg transcoder unavailable: ${probe.reason}`,
      );
    }

    let provider: TtsProvider;
    try {
      provider = await this.deps.providerFactory();
    } catch (err) {
      throw new MeetTtsError(
        "MEET_TTS_PROVIDER_UNAVAILABLE",
        `TTS provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!provider.synthesizeStream) {
      throw new MeetTtsError(
        "MEET_TTS_PROVIDER_UNAVAILABLE",
        `TTS provider "${provider.id}" does not implement synthesizeStream`,
      );
    }

    const abort = new AbortController();

    // --- ffmpeg transcode pipeline -----------------------------------------
    //
    // Provider output → ffmpeg stdin → ffmpeg stdout → HTTP POST body.
    // The decoder is format-agnostic so we accept whatever the provider
    // emits (mp3, wav, pcm of various rates) and emit the bot's expected
    // format on stdout.
    const ffmpeg = this.deps.spawn("ffmpeg", [...FFMPEG_TRANSCODE_ARGS], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Spawn-time failures (e.g. ffmpeg binary missing since the probe) arrive
    // here as an async `error` event — Node does NOT surface them as a
    // non-zero exit code. We need to (a) abort the outbound POST so the
    // fetch call doesn't hang forever on the broken stdout stream, and
    // (b) stamp the probe cache as unavailable so subsequent speaks reject
    // immediately with the correct error code.
    ffmpeg.on("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        log.warn(
          { err, meetingId: this.meetingId, streamId },
          "ffmpeg binary missing — invalidating probe cache",
        );
        this.ffmpegProbe = Promise.resolve({
          available: false,
          reason: "ffmpeg binary not found on PATH (ENOENT)",
        });
      } else {
        log.warn(
          { err, meetingId: this.meetingId, streamId },
          "ffmpeg transcode spawn/runtime error",
        );
      }
      abort.abort(err);
    });
    ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      log.debug(
        {
          meetingId: this.meetingId,
          streamId,
          stderr: chunk.toString("utf8").trim(),
        },
        "ffmpeg transcode stderr",
      );
    });

    // --- Decide which lip-sync tap to install ------------------------------
    //
    // Providers that advertise `capabilities.alignment === true` route their
    // alignment events through an `onAlignment` callback; we emit those
    // directly as viseme events. Providers without alignment fall back to
    // an RMS-amplitude extractor running over the ffmpeg-normalized PCM
    // stdout stream (guaranteed 48 kHz / mono / s16le, so a simple
    // byte-windowed RMS is accurate regardless of the provider's native
    // output format). The amplitude fallback only runs when there is at
    // least one viseme subscriber — otherwise we skip the extra work.
    const providerSupportsAlignment = provider.capabilities.alignment === true;
    const hasVisemeSubscribers = this.visemeListeners.size > 0;
    const useAmplitudeFallback =
      !providerSupportsAlignment && hasVisemeSubscribers;

    // --- Drive the provider's streaming synthesis into ffmpeg stdin --------
    //
    // We kick off synthesis concurrently with the HTTP POST so the bot
    // starts receiving audio as soon as ffmpeg emits its first output
    // bytes. Errors from the provider are handled by ending ffmpeg stdin
    // with an explicit destroy + propagating through `completion`.
    const synthesisRequest: TtsSynthesisRequest = {
      text: input.text,
      useCase: "message-playback",
      voiceId: input.voice,
      signal: abort.signal,
    };
    const onAlignment =
      providerSupportsAlignment && hasVisemeSubscribers
        ? (event: TtsAlignmentEvent) => {
            if (abort.signal.aborted) return;
            this.emitVisemeEvent({
              phoneme: event.phoneme,
              weight: clamp01(event.weight),
              timestamp: event.timestamp,
            });
          }
        : undefined;
    const synthesisPromise = provider
      .synthesizeStream(
        synthesisRequest,
        (chunk) => {
          if (abort.signal.aborted) return;
          try {
            ffmpeg.stdin.write(Buffer.from(chunk));
          } catch (err) {
            log.warn(
              { err, meetingId: this.meetingId, streamId },
              "ffmpeg stdin write threw — aborting stream",
            );
            abort.abort(err);
          }
        },
        onAlignment,
      )
      .catch((err) => {
        if (!abort.signal.aborted) {
          log.warn(
            { err, meetingId: this.meetingId, streamId },
            "TTS provider synthesizeStream rejected",
          );
          abort.abort(err);
        }
        return null;
      })
      .finally(() => {
        // Close ffmpeg stdin so it flushes and exits naturally.
        try {
          ffmpeg.stdin.end();
        } catch {
          /* already closed */
        }
      });

    // --- Build the HTTP POST body from ffmpeg stdout -----------------------
    //
    // Node's undici-backed fetch accepts a `ReadableStream` body; convert
    // the node-stream `ffmpeg.stdout` into a web stream so we can hand it
    // off to fetch with `duplex: "half"`. When the amplitude fallback is
    // active we splice a PassThrough into the pipeline so we can observe
    // every PCM byte without buffering the whole stream ourselves — the
    // tap runs RMS over 50 ms windows and emits viseme events without
    // delaying the outbound HTTP body.
    let httpBodySource: NodeJS.ReadableStream = ffmpeg.stdout;
    if (useAmplitudeFallback) {
      const tap = new PassThrough();
      ffmpeg.stdout.pipe(tap);
      this.attachAmplitudeTap(tap, abort.signal);
      httpBodySource = tap;
    }
    const bodyStream = Readable.toWeb(
      httpBodySource as Readable,
    ) as unknown as ReadableStream<Uint8Array>;

    const url = `${this.botBaseUrl}/play_audio?stream_id=${encodeURIComponent(streamId)}`;

    const postSettled = this.runPost({
      url,
      body: bodyStream,
      abort,
      streamId,
    });

    const settled = postSettled.finally(() => {
      // Make sure the provider synthesis task has completed before we
      // clear the active-stream record — otherwise a late synthesis
      // rejection could orphan state after `cancel` resolved.
      return synthesisPromise.finally(() => {
        // Best-effort kill in case ffmpeg is still alive (provider
        // rejected after we aborted, stdin close raced, etc.).
        if (!ffmpeg.killed) {
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            /* best-effort */
          }
        }
        this.streams.delete(streamId);
      });
    });

    this.streams.set(streamId, { abort, settled });

    return { streamId, completion: settled };
  }

  /**
   * Cancel an in-flight speak call. Fires the stream's abort signal which
   * aborts the outbound HTTP request; also best-effort POSTs
   * `DELETE /play_audio/<streamId>` so the bot flushes silence in place
   * of any buffered audio. Safe to call with an unknown stream id
   * (no-op).
   */
  async cancel(streamId: string): Promise<void> {
    const active = this.streams.get(streamId);
    if (!active) {
      log.debug(
        { meetingId: this.meetingId, streamId },
        "cancel(): no active stream — no-op",
      );
      return;
    }
    active.abort.abort(new MeetTtsCancelledError());
    // Best-effort DELETE — swallow failures. The outbound POST is already
    // aborted, so the bot's stdin-side of /play_audio will observe EOF
    // regardless; the DELETE is the explicit signal to flush.
    try {
      await this.deps.fetch(
        `${this.botBaseUrl}/play_audio/${encodeURIComponent(streamId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.botApiToken}` },
          signal: AbortSignal.timeout(CANCEL_DELETE_TIMEOUT_MS),
        },
      );
    } catch (err) {
      log.warn(
        { err, meetingId: this.meetingId, streamId },
        "cancel(): DELETE /play_audio failed — continuing",
      );
    }
    await active.settled.catch(() => {});
  }

  /** Number of in-flight streams. Exposed for tests. */
  activeStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Cancel every in-flight stream. Invoked from the session manager on
   * meeting leave so orphan streams don't outlive the container.
   */
  async cancelAll(): Promise<void> {
    const ids = Array.from(this.streams.keys());
    await Promise.allSettled(ids.map((id) => this.cancel(id)));
  }

  /**
   * Subscribe to per-utterance viseme events. When the active TTS provider
   * advertises `capabilities.alignment === true`, provider-sourced alignment
   * events are forwarded unchanged. Otherwise, an RMS-amplitude extractor
   * runs over the ffmpeg-normalized PCM stream and emits fallback events of
   * the shape `{ phoneme: "amp", weight, timestamp }`.
   *
   * Returns an unsubscribe function. Subscribers added before a `speak`
   * call starts receive events from that call; subscribers added after a
   * call has started are ignored by that specific in-flight call's tap
   * (the tap is installed once at the top of `speak`) but will pick up
   * the next call.
   *
   * Subscriber callbacks are invoked synchronously on the bridge's event
   * loop — they must not block or await.
   */
  onViseme(listener: VisemeListener): () => void {
    this.visemeListeners.add(listener);
    return () => {
      this.visemeListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Fan out a viseme event to every subscriber. Errors from individual
   * subscribers are logged and swallowed — a misbehaving consumer must
   * not tear down the TTS stream.
   */
  private emitVisemeEvent(event: VisemeEvent): void {
    for (const listener of this.visemeListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId, phoneme: event.phoneme },
          "onViseme subscriber threw — dropping event",
        );
      }
    }
  }

  /**
   * Wire an amplitude-envelope extractor over a PCM stream. The stream is
   * expected to be `s16le` mono at {@link BOT_AUDIO_SAMPLE_RATE_HZ}, matching
   * the ffmpeg transcode pipeline's stdout. For every 50 ms window of bytes
   * the tap computes a normalized RMS and emits a `{ phoneme: "amp", ... }`
   * viseme event with the window's start timestamp (milliseconds from the
   * beginning of this utterance).
   *
   * The tap tolerates any amount of trailing bytes that don't fill a full
   * window — leftover audio under 50 ms just doesn't emit a final event,
   * which keeps the calculation self-consistent and spares consumers a
   * ragged-edge weight.
   */
  private attachAmplitudeTap(
    stream: NodeJS.ReadableStream,
    signal: AbortSignal,
  ): void {
    let totalBytesConsumed = 0;
    let windowBuffer = Buffer.alloc(0);

    const flushWindow = (): void => {
      while (windowBuffer.length >= AMPLITUDE_BYTES_PER_WINDOW) {
        const windowBytes = windowBuffer.subarray(
          0,
          AMPLITUDE_BYTES_PER_WINDOW,
        );
        const windowStartByte = totalBytesConsumed;
        totalBytesConsumed += AMPLITUDE_BYTES_PER_WINDOW;
        windowBuffer = windowBuffer.subarray(AMPLITUDE_BYTES_PER_WINDOW);

        // Timestamp is the wall-of-bytes offset at the start of this window,
        // converted to ms. 2 bytes/sample × 48 samples/ms = 96 bytes/ms.
        const timestamp = Math.round(
          windowStartByte /
            (AMPLITUDE_BYTES_PER_SAMPLE * (AMPLITUDE_SAMPLE_RATE_HZ / 1000)),
        );

        let sumOfSquares = 0;
        for (let i = 0; i < windowBytes.length; i += 2) {
          const sample = windowBytes.readInt16LE(i);
          sumOfSquares += sample * sample;
        }
        const rms = Math.sqrt(sumOfSquares / AMPLITUDE_SAMPLES_PER_WINDOW);
        const weight = clamp01(rms / AMPLITUDE_MAX_SAMPLE);

        this.emitVisemeEvent({ phoneme: "amp", weight, timestamp });
      }
    };

    stream.on("data", (chunk: Buffer) => {
      if (signal.aborted) return;
      windowBuffer =
        windowBuffer.length === 0
          ? Buffer.from(chunk)
          : Buffer.concat([windowBuffer, chunk]);
      try {
        flushWindow();
      } catch (err) {
        log.warn(
          { err, meetingId: this.meetingId },
          "amplitude tap window flush threw — suppressing",
        );
      }
    });
  }

  private async runPost(args: {
    url: string;
    body: ReadableStream<Uint8Array>;
    abort: AbortController;
    streamId: string;
  }): Promise<void> {
    const { url, body, abort, streamId } = args;
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botApiToken}`,
          "Content-Type": "application/octet-stream",
        },
        body,
        signal: abort.signal,
        duplex: "half",
      });
    } catch (err) {
      if (abort.signal.aborted) {
        // The AbortController is shared between caller-initiated cancels
        // (which set the reason to a MeetTtsCancelledError) and internal
        // error paths (ffmpeg crash, provider reject, stdin write error)
        // which set the reason to the original error. Only surface a
        // MeetTtsCancelledError when the abort was actually a cancel —
        // otherwise propagate the original reason so the session manager's
        // classifier emits `reason: "error"`.
        if (abort.signal.reason instanceof MeetTtsCancelledError) {
          throw abort.signal.reason;
        }
        // Internal error aborted the signal — propagate the original cause.
        throw abort.signal.reason instanceof Error
          ? abort.signal.reason
          : new MeetTtsError(
              "MEET_TTS_BOT_UNREACHABLE",
              `Bot /play_audio aborted for streamId=${streamId}: ${String(abort.signal.reason)}`,
            );
      }
      throw new MeetTtsError(
        "MEET_TTS_BOT_UNREACHABLE",
        `Bot /play_audio unreachable for streamId=${streamId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      // Check abort before throwing BOT_REJECTED — a 4xx/5xx racing with
      // a caller-cancel should classify as cancel, not error. Symmetric
      // with the post-drain abort check on the 200 path below.
      if (abort.signal.aborted) {
        if (abort.signal.reason instanceof MeetTtsCancelledError) {
          throw abort.signal.reason;
        }
        throw abort.signal.reason instanceof Error
          ? abort.signal.reason
          : new MeetTtsError(
              "MEET_TTS_BOT_REJECTED",
              `Bot /play_audio returned ${response.status} for streamId=${streamId} (aborted)`,
              response.status,
            );
      }
      const detail = await response.text().catch(() => "");
      throw new MeetTtsError(
        "MEET_TTS_BOT_REJECTED",
        `Bot /play_audio returned ${response.status} for streamId=${streamId}: ${detail}`,
        response.status,
      );
    }
    // Drain any body the bot returned so the connection can be reused.
    await response.arrayBuffer().catch(() => {});
    // Check abort after a "successful" drain: some fetch implementations
    // resolve the response before propagating a late abort. If the caller
    // cancelled mid-stream, surface that as a cancel so speaking_ended
    // reports reason=cancelled even on races where the bot saw EOF and
    // replied 200 before the abort propagated.
    if (abort.signal.aborted) {
      if (abort.signal.reason instanceof MeetTtsCancelledError) {
        throw abort.signal.reason;
      }
      // Internal error aborted after a successful drain — propagate the
      // original cause rather than misclassifying as cancelled.
      throw abort.signal.reason instanceof Error
        ? abort.signal.reason
        : new Error(String(abort.signal.reason));
    }
  }

  /**
   * One-shot, memoized `ffmpeg -version` probe. Spawns ffmpeg with
   * `-version` and waits for either an `exit` event (any exit code means
   * "ffmpeg ran") or an `error` event (ENOENT means the binary is missing).
   *
   * The probe deliberately does not treat a non-zero exit code as
   * unavailable — a user with a corrupted ffmpeg build would still hit the
   * downstream transcode failure with a more specific error. We only
   * surface the pre-flight "missing binary" case here so `meet_speak`
   * callers can distinguish a missing dependency from a transient bot
   * failure.
   */
  private ensureFfmpegAvailable(): Promise<FfmpegProbeResult> {
    if (this.ffmpegProbe) return this.ffmpegProbe;
    this.ffmpegProbe = new Promise<FfmpegProbeResult>((resolve) => {
      let settled = false;
      const settle = (result: FfmpegProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<SpawnFn>;
      try {
        child = this.deps.spawn("ffmpeg", ["-version"], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (err) {
        // Synchronous spawn failure — very unusual, but treat the same as
        // an async ENOENT.
        settle({
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      child.on("error", (err) => {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr?.code === "ENOENT") {
          settle({
            available: false,
            reason: "ffmpeg binary not found on PATH (ENOENT)",
          });
        } else {
          // Transient error (EMFILE, EAGAIN, etc.) — clear the memoized
          // probe so the next speak() retries instead of being stuck on a
          // sticky false negative.
          this.ffmpegProbe = null;
          settle({
            available: false,
            reason: `ffmpeg probe failed (transient): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
      child.on("exit", () => {
        // Any exit — zero or non-zero — means ffmpeg was runnable.
        settle({ available: true });
      });
    });
    return this.ffmpegProbe;
  }
}
