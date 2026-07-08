/**
 * Provider-aware speech output for deterministic call prompts.
 *
 * Deterministic call prompts (verification codes, guardian wait updates,
 * timeout copy, failure copy, etc.) are routed through the same provider
 * abstraction used by the call controller so that configured synthesized
 * providers (e.g. Fish Audio) are respected for all spoken output.
 *
 * Two output paths (determined by the catalog's `callMode`):
 * - **Native**: `callMode: "native-twilio"` — text is sent via
 *   `sendTextToken()`, which the media-stream transport re-synthesizes
 *   through daemon TTS.
 * - **Synthesized**: `callMode: "synthesized-play"` — text is synthesized
 *   via the provider API, streamed through the audio store, and played
 *   via `sendPlayUrl()`.
 */

import { getCatalogProvider } from "../tts/provider-catalog.js";
import {
  type AudioStoreSink,
  createAudioStoreSink,
  synthesizeAndEmit,
} from "../tts/synthesis-stream.js";
import type { TtsProvider, TtsProviderId } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import type { CallAudioFormat } from "./audio-store.js";
import type { CallTransport } from "./call-transport.js";
import {
  findPlayableTelephonyTtsFallbackProvider,
  resolveCallTtsProvider,
  resolveSynthesisFormats,
} from "./resolve-call-tts-provider.js";

const log = getLogger("call-speech-output");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Speak a deterministic text prompt through the active TTS provider.
 *
 * For native providers this is equivalent to `relay.sendTextToken(text, true)`
 * and resolves immediately (synchronous send).
 *
 * For synthesized providers this synthesizes audio via the provider API,
 * sends the play URL to the relay, and resolves once synthesis is complete.
 * Callers in disconnect/teardown flows should `await` the returned promise
 * before starting teardown timers so that the play URL is delivered to
 * Twilio before the session ends. Interactive mid-call callers can
 * fire-and-forget with `void speakSystemPrompt(...)`.
 *
 * The optional `signal` aborts in-flight synthesis on the synthesized path;
 * the native path sends synchronously and ignores it.
 */
export async function speakSystemPrompt(
  relay: CallTransport,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  // When the transport requires PCM (media-stream), request PCM so
  // the audio store entry contains raw PCM that audioBufferToFrames can
  // transcode to mu-law. Without this, compressed formats (mp3, opus)
  // are fetched by processFetchUrlItem and produce garbled audio.
  const { provider, useSynthesizedPath, audioFormat } =
    await resolveCallTtsProvider({
      requiresPcmAudio: relay.requiresPcmAudio,
    });

  if (!useSynthesizedPath || !provider) {
    // Native path — send text tokens through the transport.
    relay.sendTextToken(text, true);
    return;
  }

  // Synthesized path — synthesize audio and send play URL.
  return synthesizeAndPlay(relay, provider, text, audioFormat, signal);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize text via a streaming TTS provider and send the play URL
 * to the transport.
 *
 * A failure after the play URL has gone out (streaming provider died
 * mid-stream) sends only the end-of-turn signal on every transport: the
 * caller already heard the truncated prompt, and any fallback would
 * re-speak it in full.
 *
 * On synthesis failure before any audio the behavior depends on the
 * transport:
 * - PCM-requiring transports (media-stream) retry once with a playable
 *   fallback provider — native token TTS cannot rescue the prompt there
 *   because text tokens are themselves synthesized via the same provider
 *   path. When no fallback exists (or the retry also fails), only an
 *   empty end-of-turn signal is sent so the transport transitions back
 *   to listening state.
 * - On non-PCM transports, providers with a native Twilio TTS fallback
 *   (e.g. Fish Audio) fall back to `sendTextToken(text)` so the caller
 *   still hears the message; providers without one (e.g. Deepgram) log
 *   the error and send only the end-of-turn signal.
 *
 * Cancellation (our own `signal` aborted) short-circuits all of the
 * above: no fallback, no end-of-turn token — the canceller owns turn
 * state. A provider-internal `AbortError` without our signal aborted is
 * a synthesis failure and takes the normal fallback path.
 */
async function synthesizeAndPlay(
  relay: CallTransport,
  provider: TtsProvider,
  text: string,
  format: CallAudioFormat,
  signal?: AbortSignal,
  isFallbackRetry = false,
): Promise<void> {
  let sink: AudioStoreSink | null = null;
  let playUrlSent = false;
  try {
    const { outputFormat, storeFormat } = resolveSynthesisFormats(format);
    sink = createAudioStoreSink({
      format: storeFormat,
      onPlayUrl: (url) => {
        relay.sendPlayUrl(url);
        playUrlSent = true;
      },
    });

    const result = await synthesizeAndEmit({
      provider,
      text,
      useCase: "phone-call",
      outputFormat,
      signal,
      onChunk: sink.onChunk,
      onFirstAudio: sink.onFirstAudio,
    });

    // synthesizeAndEmit resolves silently (without throwing) when the
    // signal aborts after the provider resolves but before queued emits
    // run. Same contract as the catch-side abort: the canceller owns turn
    // state, so skip the end-of-turn token.
    if (result.stopped) {
      log.debug(
        { provider: provider.id },
        "System prompt TTS synthesis aborted after resolve — skipping end-of-turn",
      );
      return;
    }

    // Signal end of this turn's speech.  An empty token with `last: true`
    // tells the transport to start listening — it does NOT trigger TTS
    // synthesis.  This is required even when a synthesized provider handled
    // all audio playback, because the transport still needs the end-of-turn
    // signal to transition from "assistant speaking" to "caller speaking"
    // state.
    relay.sendTextToken("", true);
  } catch (err) {
    // Cancelled synthesis (e.g. barge-in): the canceller owns turn state,
    // so skip fallback and the end-of-turn signal entirely (mirrors
    // call-controller's aborted-synthesis handling). Requires our own
    // signal to be aborted — a provider-internal AbortError without it is
    // a synthesis failure and must take the fallback/end-of-turn path.
    if (signal?.aborted) {
      log.debug(
        { provider: provider.id },
        "System prompt TTS synthesis aborted — skipping fallback",
      );
      return;
    }

    // Extract error class and code for diagnosable log entries.
    const errName = err instanceof Error ? err.name : String(err);
    const errCode =
      err instanceof Error && "code" in err
        ? (err as Error & { code?: string }).code
        : undefined;

    // The caller already heard the truncated prompt — any fallback would
    // re-speak it in full (mirrors call-controller's failed-after-audio).
    if (playUrlSent) {
      log.warn(
        { err, provider: provider.id, errName, errCode },
        "System prompt TTS synthesis failed after audio started — skipping fallback to avoid re-speaking the prompt",
      );
      relay.sendTextToken("", true);
      return;
    }

    if (relay.requiresPcmAudio) {
      // PCM-requiring transport (media-stream): native token TTS routes
      // back through the same synthesis path, so retry once with a
      // playable fallback provider before degrading to end-of-turn only.
      if (!isFallbackRetry) {
        const fallbackProvider = await findPlayableTelephonyTtsFallbackProvider(
          provider.id,
        );
        if (fallbackProvider) {
          log.warn(
            {
              err,
              provider: provider.id,
              fallbackProvider: fallbackProvider.id,
              errName,
              errCode,
            },
            "System prompt TTS synthesis failed — retrying with fallback provider",
          );
          sink?.finalize();
          sink = null;
          return await synthesizeAndPlay(
            relay,
            fallbackProvider,
            text,
            format,
            signal,
            true,
          );
        }
      }
      log.error(
        { err, provider: provider.id, errName, errCode },
        "System prompt TTS synthesis failed on PCM-requiring transport — sending end-of-turn only",
      );
      // Send the end-of-turn signal so the transport transitions from
      // "assistant speaking" to "caller speaking" state.
      relay.sendTextToken("", true);
      return;
    }

    // `allowNativeFallback` controls whether the system prompt text
    // should be sent via native Twilio token-based TTS when synthesis
    // fails. When false (e.g. Deepgram), the design choice is to
    // send only an end-of-turn signal — the caller hears nothing for
    // this prompt — rather than degrading to a mismatched voice.
    // Callers use fire-and-forget (`void speakSystemPrompt(...)`) so
    // throwing here would produce an unhandled promise rejection.
    const catalogEntry = getCatalogProvider(provider.id as TtsProviderId);
    if (!catalogEntry.allowNativeFallback) {
      log.error(
        { err, provider: provider.id, errName, errCode },
        "System prompt TTS synthesis failed — native fallback disabled for this provider",
      );
      // Send the end-of-turn signal so the transport transitions from
      // "assistant speaking" to "caller speaking" state. Without this,
      // the session hangs waiting for the prompt to complete and the
      // caller cannot interact.
      relay.sendTextToken("", true);
      return;
    }

    log.error(
      { err, provider: provider.id, errName, errCode },
      "System prompt TTS synthesis failed — falling back to native TTS",
    );
    // Fallback: send text via native TTS so the caller still hears the message.
    // sendTextToken with last:true includes the end-of-turn signal inherently.
    // This fallback is only used for providers whose catalog entry allows
    // native fallback.
    relay.sendTextToken(text, true);
  } finally {
    sink?.finalize();
  }
}
