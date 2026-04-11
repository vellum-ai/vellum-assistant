/**
 * Provider-aware speech output for deterministic call prompts.
 *
 * Deterministic call prompts (verification codes, guardian wait updates,
 * timeout copy, failure copy, etc.) are routed through the same provider
 * abstraction used by the call controller so that configured synthesized
 * providers (e.g. Fish Audio) are respected for all spoken output.
 *
 * Two output paths:
 * - **Native**: Provider does not support streaming — text is sent via
 *   `sendTextToken()` for Twilio's built-in TTS engine.
 * - **Synthesized**: Provider supports streaming — text is synthesized
 *   via the provider API, streamed through the audio store, and played
 *   via `sendPlayUrl()`.
 */

import { loadConfig } from "../config/loader.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProvider } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import { createStreamingEntry } from "./audio-store.js";
import type { RelayConnection } from "./relay-server.js";

const log = getLogger("call-speech-output");

// ---------------------------------------------------------------------------
// Provider resolution (shared logic with call-controller)
// ---------------------------------------------------------------------------

interface ResolvedCallTts {
  provider: TtsProvider | null;
  useSynthesizedPath: boolean;
  audioFormat: "mp3" | "wav" | "opus";
}

/**
 * Resolve the active TTS provider via the global provider abstraction.
 *
 * Mirrors the resolution logic in CallController.resolveCallTtsProvider()
 * so deterministic prompts use the same provider path as LLM-generated
 * speech.
 */
function resolveCallTtsProvider(): ResolvedCallTts {
  try {
    const config = loadConfig();
    const resolved = resolveTtsConfig(config);
    const provider = getTtsProvider(resolved.provider);
    const useSynthesizedPath = provider.capabilities.supportsStreaming;
    const configuredFormat = (resolved.providerConfig as { format?: string })
      .format;
    const audioFormat = (
      configuredFormat && ["mp3", "wav", "opus"].includes(configuredFormat)
        ? configuredFormat
        : "mp3"
    ) as "mp3" | "wav" | "opus";
    return { provider, useSynthesizedPath, audioFormat };
  } catch {
    // Config missing or provider not registered — fall back to native path.
    return { provider: null, useSynthesizedPath: false, audioFormat: "mp3" };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Speak a deterministic text prompt through the active TTS provider.
 *
 * For native providers this is equivalent to `relay.sendTextToken(text, true)`.
 * For synthesized providers this synthesizes audio via the provider API and
 * sends the play URL to the relay.
 *
 * The function is intentionally fire-and-forget for the synthesized path —
 * callers that need to wait for TTS playback to complete should still use
 * `getTtsPlaybackDelayMs()` for scheduling follow-up actions (e.g. ending
 * the session after a goodbye message).
 */
export function speakSystemPrompt(relay: RelayConnection, text: string): void {
  const { provider, useSynthesizedPath, audioFormat } =
    resolveCallTtsProvider();

  if (!useSynthesizedPath || !provider) {
    // Native path — send text for Twilio's built-in TTS.
    relay.sendTextToken(text, true);
    return;
  }

  // Synthesized path — synthesize audio and send play URL.
  // Fire-and-forget: callers use getTtsPlaybackDelayMs() for timing.
  void synthesizeAndPlay(relay, provider, text, audioFormat);
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
  relay: RelayConnection,
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

    // Send the play URL only after synthesis succeeds so that Twilio never
    // receives a play message pointing to empty/broken audio on failure.
    relay.sendPlayUrl(url);

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
