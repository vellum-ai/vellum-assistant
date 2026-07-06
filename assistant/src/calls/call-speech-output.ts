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

import { loadConfig } from "../config/loader.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import { getCatalogProvider, getTtsProvider } from "../tts/provider-catalog.js";
import type { TtsProvider, TtsProviderId } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import { createStreamingEntry } from "./audio-store.js";
import type { CallTransport } from "./call-transport.js";
import {
  findPlayableTelephonyTtsFallback,
  resolveCallTtsProvider,
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
 */
export async function speakSystemPrompt(
  relay: CallTransport,
  text: string,
): Promise<void> {
  // When the transport requires WAV (media-stream), request WAV so
  // the audio store entry contains PCM that audioBufferToFrames can
  // transcode to mu-law. Without this, compressed formats (mp3, opus)
  // are fetched by processFetchUrlItem and produce garbled audio.
  const { provider, useSynthesizedPath, audioFormat } =
    await resolveCallTtsProvider({
      preferWav: relay.requiresWavAudio,
    });

  if (!useSynthesizedPath || !provider) {
    // Native path — send text tokens through the transport.
    relay.sendTextToken(text, true);
    return;
  }

  // Synthesized path — synthesize audio and send play URL.
  return synthesizeAndPlay(relay, provider, text, audioFormat);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize text via a streaming TTS provider and send the play URL
 * to the transport.
 *
 * On synthesis failure the behavior depends on the transport:
 * - WAV-requiring transports (media-stream) retry once with a playable
 *   fallback provider — native token TTS cannot rescue the prompt there
 *   because text tokens are themselves synthesized via the same provider
 *   path. When no fallback exists (or the retry also fails), only an
 *   empty end-of-turn signal is sent so the transport transitions back
 *   to listening state.
 * - On non-WAV transports, providers with a native Twilio TTS fallback
 *   (e.g. Fish Audio) fall back to `sendTextToken(text)` so the caller
 *   still hears the message; providers without one (e.g. Deepgram) log
 *   the error and send only the end-of-turn signal.
 */
async function synthesizeAndPlay(
  relay: CallTransport,
  provider: TtsProvider,
  text: string,
  format: "mp3" | "wav" | "opus",
  isFallbackRetry = false,
): Promise<void> {
  let handle: ReturnType<typeof createStreamingEntry> | null = null;
  let playUrlSent = false;
  try {
    // When format is WAV (media-stream transport), request raw PCM from
    // the provider so the audio bytes match the store's content-type.
    // Without this, providers like Fish Audio still return mp3 and the
    // downstream mu-law transcoder fails on the format mismatch.
    const outputFormat = format === "wav" ? ("pcm" as const) : undefined;

    // Use "pcm" as the store format when requesting PCM output so the
    // audio store entry's content-type (audio/pcm) matches the raw PCM
    // bytes providers return. Without this, the store says "audio/wav"
    // but the bytes have no RIFF header, causing audioBufferToFrames to
    // fall through to the wrong decode path.
    const storeFormat = outputFormat ? "pcm" : format;
    handle = createStreamingEntry(storeFormat);
    const config = loadConfig();
    const baseUrl = getPublicBaseUrl(config);
    const url = `${baseUrl}/v1/audio/${handle.audioId}`;
    const sendPlayUrlOnce = (): void => {
      if (playUrlSent) return;
      relay.sendPlayUrl(url);
      playUrlSent = true;
    };

    if (provider.synthesizeStream) {
      let streamedChunk = false;
      await provider.synthesizeStream(
        { text, useCase: "phone-call", outputFormat },
        (chunk) => {
          if (chunk.byteLength === 0) return;
          if (!streamedChunk) {
            sendPlayUrlOnce();
            streamedChunk = true;
          }
          handle!.push(chunk);
        },
      );
      if (!streamedChunk) {
        throw new Error("Streaming TTS returned no audio chunks");
      }
    } else {
      const result = await provider.synthesize({
        text,
        useCase: "phone-call",
        outputFormat,
      });
      if (result.audio.byteLength === 0) {
        throw new Error("Buffer TTS returned an empty audio payload");
      }
      sendPlayUrlOnce();
      handle.push(result.audio);
    }

    // Signal end of this turn's speech.  An empty token with `last: true`
    // tells the transport to start listening — it does NOT trigger TTS
    // synthesis.  This is required even when a synthesized provider handled
    // all audio playback, because the transport still needs the end-of-turn
    // signal to transition from "assistant speaking" to "caller speaking"
    // state.
    relay.sendTextToken("", true);
  } catch (err) {
    // Extract error class and code for diagnosable log entries.
    const errName = err instanceof Error ? err.name : String(err);
    const errCode =
      err instanceof Error && "code" in err
        ? (err as Error & { code?: string }).code
        : undefined;

    if (relay.requiresWavAudio) {
      // WAV-requiring transport (media-stream): native token TTS routes
      // back through the same synthesis path, so retry once with a
      // playable fallback provider before degrading to end-of-turn only.
      if (!isFallbackRetry) {
        const fallbackId = await findPlayableTelephonyTtsFallback(
          provider.id as TtsProviderId,
        );
        const fallbackProvider = fallbackId
          ? lookupRegisteredProvider(fallbackId)
          : null;
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
          handle?.finalize();
          handle = null;
          return await synthesizeAndPlay(
            relay,
            fallbackProvider,
            text,
            format,
            true,
          );
        }
      }
      log.error(
        { err, provider: provider.id, errName, errCode },
        "System prompt TTS synthesis failed on WAV-requiring transport — sending end-of-turn only",
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
    handle?.finalize();
  }
}

/** Look up a registered provider, returning null instead of throwing. */
function lookupRegisteredProvider(id: string): TtsProvider | null {
  try {
    return getTtsProvider(id);
  } catch {
    return null;
  }
}
