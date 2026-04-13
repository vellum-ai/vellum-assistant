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
import type { TtsProvider } from "../tts/types.js";
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
  // When the transport requires WAV (media-stream), request WAV so
  // the audio store entry contains PCM that audioBufferToFrames can
  // transcode to mu-law. Without this, compressed formats (mp3, opus)
  // are fetched by processFetchUrlItem and produce garbled audio.
  const { provider, useSynthesizedPath, audioFormat } = resolveCallTtsProvider({
    preferWav: relay.requiresWavAudio,
  });

  if (!useSynthesizedPath || !provider) {
    // Native path — send text for Twilio's built-in TTS.
    relay.sendTextToken(text, true);
    return Promise.resolve();
  }

  // Synthesized path — synthesize audio and send play URL.
  return synthesizeAndPlay(relay, provider, text, audioFormat);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize text via a streaming TTS provider and send the play URL
 * to the relay. Falls back to sendTextToken on synthesis failure so the
 * caller always hears something.
 */
async function synthesizeAndPlay(
  relay: CallTransport,
  provider: TtsProvider,
  text: string,
  format: "mp3" | "wav" | "opus",
): Promise<void> {
  let handle: ReturnType<typeof createStreamingEntry> | null = null;
  try {
    handle = createStreamingEntry(format);
    const config = loadConfig();
    const baseUrl = getPublicBaseUrl(config);
    const url = `${baseUrl}/v1/audio/${handle.audioId}`;

    // Send the play URL FIRST so Twilio can start playing audio as soon as
    // chunks arrive in the streaming store. This avoids the caller hearing
    // silence during the full synthesis latency window.
    relay.sendPlayUrl(url);

    if (provider.synthesizeStream) {
      await provider.synthesizeStream(
        { text, useCase: "phone-call" },
        (chunk) => handle!.push(chunk),
      );
    } else {
      const result = await provider.synthesize({
        text,
        useCase: "phone-call",
      });
      handle.push(result.audio);
    }

    // Signal end of this turn's speech.  An empty token with `last: true`
    // tells ConversationRelay to start listening — it does NOT trigger TTS
    // synthesis.  This is required even when a synthesized provider handled
    // all audio playback, because ConversationRelay still needs the
    // end-of-turn signal to transition from "assistant speaking" to
    // "caller speaking" state.
    relay.sendTextToken("", true);
  } catch (err) {
    log.error(
      { err, provider: provider.id },
      "System prompt TTS synthesis failed — falling back to native TTS",
    );
    // Fallback: send text via native TTS so the caller still hears the message.
    // sendTextToken with last:true includes the end-of-turn signal inherently.
    relay.sendTextToken(text, true);
  } finally {
    handle?.finalize();
  }
}
