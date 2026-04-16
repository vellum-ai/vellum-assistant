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
import { Readable } from "node:stream";

import { getLogger } from "../../../assistant/src/util/logger.js";
import type {
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
 * ffmpeg arguments that read whatever format the TTS provider emits on
 * stdin and write raw 48 kHz / mono / s16le PCM on stdout. The decoder is
 * format-agnostic (no `-f` on input) so the same pipeline accepts mp3,
 * wav, or raw provider-native PCM without branching.
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
    // Surface ffmpeg errors at debug; a real spawn failure propagates as
    // an exit with a non-zero code which we catch below.
    ffmpeg.on("error", (err) => {
      log.warn(
        { err, meetingId: this.meetingId, streamId },
        "ffmpeg transcode spawn/runtime error",
      );
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
    const synthesisPromise = provider
      .synthesizeStream(synthesisRequest, (chunk) => {
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
      })
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
    // off to fetch with `duplex: "half"`.
    const bodyStream = Readable.toWeb(
      ffmpeg.stdout,
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
        // Caller-initiated cancel (explicit cancel / cancelAll / barge-in).
        // Surface via a typed sentinel so the session manager's classifier
        // can publish `meet.speaking_ended { reason: "cancelled" }` instead
        // of misclassifying the cancel as a natural completion.
        throw new MeetTtsCancelledError();
      }
      throw new MeetTtsError(
        "MEET_TTS_BOT_UNREACHABLE",
        `Bot /play_audio unreachable for streamId=${streamId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
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
      throw new MeetTtsCancelledError();
    }
  }
}
