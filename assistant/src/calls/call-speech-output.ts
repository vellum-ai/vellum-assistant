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
 *   `sendTextToken()` for Twilio's built-in TTS engine.
 * - **Synthesized**: `callMode: "synthesized-play"` — text is synthesized
 *   via the provider API, streamed through the audio store, and played
 *   via `sendPlayUrl()`.
 */

import { loadConfig } from "../config/loader.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import type { TtsProvider, TtsProviderId } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import { createStreamingEntry } from "./audio-store.js";
import type { CallTransport } from "./call-transport.js";
import { resolveCallTtsProvider } from "./resolve-call-tts-provider.js";

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
export function speakSystemPrompt(
  relay: CallTransport,
  text: string,
): Promise<void> {
  // Media-stream transport: hand the prompt text directly to the transport's
  // own synthesis path. `sendTextToken(text, true)` makes MediaStreamOutput
  // accumulate the text and, on `last: true`, synthesize it via a
  // playability-guarded provider, transcode PCM -> mu-law, and stream the
  // frames straight over the media-stream WebSocket. This needs NO public
  // base URL, so managed/Velay deployments (empty `ingress.publicBaseUrl`)
  // are no longer silent.
  if (relay.requiresWavAudio) {
    return speakSystemPromptOverMediaStream(relay, text);
  }

  const { provider, useSynthesizedPath, audioFormat } =
    resolveCallTtsProvider();

  if (!useSynthesizedPath || !provider) {
    // Native path — send text for Twilio's built-in TTS.
    relay.sendTextToken(text, true);
    return Promise.resolve();
  }

  // Synthesized path — synthesize audio and send play URL.
  return synthesizeAndPlay(relay, provider, text, audioFormat);
}

/**
 * Speak a deterministic prompt over the media-stream transport.
 *
 * Hands the prompt text directly to the transport via
 * `sendTextToken(text, true)`. MediaStreamOutput then synthesizes the
 * accumulated text through its own playability-guarded provider
 * (`resolvePlayableCallTtsProvider` inside `processSynthesizeItem`),
 * transcodes PCM -> mu-law, and streams the frames over the WebSocket —
 * with NO public audio URL / audio-store round-trip. This avoids the
 * `getPublicBaseUrl()` dependency that left managed/Velay deployments
 * (empty `ingress.publicBaseUrl`) connected-but-silent. Provider
 * resolution, fallback, and failure logging are handled internally by
 * MediaStreamOutput.
 */
function speakSystemPromptOverMediaStream(
  relay: CallTransport,
  text: string,
): Promise<void> {
  relay.sendTextToken(text, true);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize text via a streaming TTS provider and send the play URL
 * to the relay.
 *
 * On synthesis failure the behavior depends on the provider:
 * - Providers with a native Twilio TTS fallback (e.g. Fish Audio) fall
 *   back to `sendTextToken(text)` so the caller still hears the message.
 * - Providers without a native fallback (e.g. Deepgram) log the error
 *   and send only an empty end-of-turn signal — the caller hears nothing
 *   but the relay transitions back to listening state.
 */
async function synthesizeAndPlay(
  relay: CallTransport,
  provider: TtsProvider,
  text: string,
  format: "mp3" | "wav" | "opus",
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
    // marks end-of-turn on the transport so it starts listening — it does
    // NOT trigger TTS synthesis.  This is required even when a synthesized
    // provider handled all audio playback, because the transport still needs
    // the end-of-turn signal to transition from "assistant speaking" to
    // "caller speaking" state.
    relay.sendTextToken("", true);
  } catch (err) {
    // Extract error class and code for diagnosable log entries.
    const errName = err instanceof Error ? err.name : String(err);
    const errCode =
      err instanceof Error && "code" in err
        ? (err as Error & { code?: string }).code
        : undefined;

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
      // "assistant speaking" to "caller speaking" state. Without this, the
      // transport hangs waiting for the prompt to complete and the caller
      // cannot interact.
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
