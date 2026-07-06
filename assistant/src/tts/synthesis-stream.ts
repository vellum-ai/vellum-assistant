/**
 * Shared synthesize-and-emit core for TTS output paths.
 *
 * Owns the streaming-vs-buffer provider selection, empty-payload guards,
 * abort/staleness emission gating, and the first-audio hook that telephony
 * and live-voice synthesis paths share. Callers resolve the provider and
 * plug in a sink (`onChunk`/`onFirstAudio`) — e.g. {@link createAudioStoreSink}
 * for transports that play audio via the audio store's `/v1/audio/:id` URLs.
 */

import { createStreamingEntry } from "../calls/audio-store.js";
import { loadConfig } from "../config/loader.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
  TtsUseCase,
} from "./types.js";

// ---------------------------------------------------------------------------
// synthesizeAndEmit
// ---------------------------------------------------------------------------

/** A single emitted audio chunk. */
export interface SynthesisEmitChunk {
  audio: Buffer;

  /**
   * MIME type of the audio. The buffer path carries the provider-reported
   * `result.contentType`; streamed chunks carry the empty string because the
   * `TtsProvider` contract reports content type only with the final result —
   * streaming sinks derive the type from their own format config (see
   * {@link SynthesisEmitResult.contentType} for the end-of-stream value).
   */
  contentType: string;
}

export interface SynthesisEmitOptions {
  /** Pre-resolved TTS provider adapter. */
  provider: TtsProvider;

  /** Pre-sanitized text to synthesize. */
  text: string;

  useCase: TtsUseCase;

  voiceId?: string;

  /** Output-encoding hint forwarded on the provider request (e.g. `"pcm"`). */
  outputFormat?: TtsSynthesisRequest["outputFormat"];

  /**
   * Advisory playback sample rate for sinks/consumers. Not part of
   * {@link TtsSynthesisRequest} — providers negotiate sample rate via their
   * own config.
   */
  sampleRate?: number;

  /** Abort signal forwarded to the provider and checked before each emit. */
  signal?: AbortSignal;

  /**
   * Staleness predicate (run-version / turn-token) checked before each emit.
   * Once it returns `false`, emission stops silently — no error is thrown
   * and no further `onChunk`/`onFirstAudio` calls are made.
   */
  isCurrent?: () => boolean;

  /** Sink for emitted audio. Async sinks are applied in emission order. */
  onChunk: (chunk: SynthesisEmitChunk) => void | Promise<void>;

  /** Fires exactly once, before the first `onChunk`. */
  onFirstAudio?: () => void;
}

export interface SynthesisEmitResult {
  emittedChunks: number;

  /** Provider-reported MIME type of the complete synthesized audio. */
  contentType: string;
}

/**
 * Synthesize text through the provider and emit audio to the sink.
 *
 * Streams when the provider supports `synthesizeStream`, otherwise falls
 * back to buffer-oriented `synthesize`. Empty chunks are skipped; a stream
 * that completes without emitting anything (and a buffer result with an
 * empty payload) is an error. Provider failures — including `AbortError`
 * from an aborted `signal` — propagate to the caller unmodified.
 */
export async function synthesizeAndEmit(
  options: SynthesisEmitOptions,
): Promise<SynthesisEmitResult> {
  const { provider, signal, isCurrent, onChunk, onFirstAudio } = options;
  const request: TtsSynthesisRequest = {
    text: options.text,
    useCase: options.useCase,
    voiceId: options.voiceId,
    outputFormat: options.outputFormat,
    signal,
  };

  let emittedChunks = 0;
  let stopped = false;
  const shouldStop = (): boolean => {
    if (!stopped && (signal?.aborted || isCurrent?.() === false)) {
      stopped = true;
    }
    return stopped;
  };

  if (provider.synthesizeStream) {
    // Sink calls are chained so async sinks observe chunks in emission
    // order. The chain itself never rejects — the first sink error is
    // captured (stopping further emits) and rethrown after the provider
    // stream resolves, so no rejection sits unhandled mid-stream.
    let pendingEmits: Promise<void> = Promise.resolve();
    let sinkFailure: { err: unknown } | undefined;
    let result: TtsSynthesisResult;
    const streamed = provider.synthesizeStream(request, (chunk) => {
      if (chunk.byteLength === 0) {
        return;
      }
      if (shouldStop()) {
        return;
      }
      // Owned copy (Buffer.from(Uint8Array) copies; the buffer/offset form
      // would alias): the emit is deferred through the chain, so a provider
      // reusing its chunk buffer must not mutate what we queued.
      const audio = Buffer.from(chunk);
      pendingEmits = pendingEmits
        .then(() => {
          // Re-checked at emit time: an abort/staleness flip (or sink
          // failure) while an earlier sink call was in flight must
          // suppress chunks that were queued before it.
          if (shouldStop()) {
            return;
          }
          if (emittedChunks === 0) {
            onFirstAudio?.();
          }
          emittedChunks += 1;
          return onChunk({ audio, contentType: "" });
        })
        .catch((err: unknown) => {
          sinkFailure ??= { err };
          stopped = true;
        });
    });
    try {
      result = await streamed;
    } catch (err) {
      // Provider failure: gate off queued emits and drain the chain (it
      // never rejects) so no sink call runs after the caller starts error
      // handling, then surface the provider error.
      stopped = true;
      await pendingEmits;
      throw err;
    }
    await pendingEmits;
    if (sinkFailure) {
      throw sinkFailure.err;
    }
    if (emittedChunks === 0 && !stopped) {
      throw new Error("Streaming TTS returned no audio chunks");
    }
    return { emittedChunks, contentType: result.contentType };
  }

  const result = await provider.synthesize(request);
  if (result.audio.byteLength === 0) {
    throw new Error("Buffer TTS returned an empty audio payload");
  }
  if (!shouldStop()) {
    onFirstAudio?.();
    emittedChunks = 1;
    await onChunk({ audio: result.audio, contentType: result.contentType });
  }
  return { emittedChunks, contentType: result.contentType };
}

// ---------------------------------------------------------------------------
// Audio-store sink
// ---------------------------------------------------------------------------

/** Audio formats accepted by the audio store. */
export type AudioStoreFormat = Parameters<typeof createStreamingEntry>[0];

export interface AudioStoreSinkOptions {
  /** Store format — determines the entry's served content type. */
  format: AudioStoreFormat;

  /**
   * Invoked exactly once, when the first audio chunk arrives, with the
   * entry's public play URL.
   */
  onPlayUrl: (url: string) => void;

  /** Streaming-entry factory, injectable for tests. */
  createEntry?: typeof createStreamingEntry;
}

export interface AudioStoreSink {
  onChunk: (chunk: SynthesisEmitChunk) => void;
  onFirstAudio: () => void;

  /**
   * Marks the store entry complete. Callers must invoke this in a `finally`
   * so subscribers of a partially-streamed entry are released on failure.
   */
  finalize: () => void;
}

/**
 * Create a {@link synthesizeAndEmit} sink that pushes audio into a streaming
 * audio-store entry and announces its `${baseUrl}/v1/audio/${audioId}` play
 * URL on first audio.
 */
export function createAudioStoreSink(
  options: AudioStoreSinkOptions,
): AudioStoreSink {
  const createEntry = options.createEntry ?? createStreamingEntry;
  const handle = createEntry(options.format);
  const baseUrl = getPublicBaseUrl(loadConfig());
  const url = `${baseUrl}/v1/audio/${handle.audioId}`;

  let playUrlSent = false;
  const sendPlayUrlOnce = (): void => {
    if (playUrlSent) {
      return;
    }
    playUrlSent = true;
    options.onPlayUrl(url);
  };

  return {
    onFirstAudio: sendPlayUrlOnce,
    onChunk(chunk) {
      sendPlayUrlOnce();
      handle.push(chunk.audio);
    },
    finalize() {
      handle.finalize();
    },
  };
}
