/**
 * Plugin-facing facade for opening a streaming speech-to-text session against
 * the assistant's configured STT provider stack.
 *
 * A session is the streaming counterpart to the stateless `synthesizeText`
 * (TTS) helper: the plugin feeds raw audio chunks in via `sendAudio` and
 * receives partial and final transcript events back through the
 * `start(onEvent)` callback, closing with `stop`. The consumer drives this
 * three-method contract without knowing the concrete provider (Deepgram,
 * Whisper, Gemini, xAI, or Vellum-managed speech), its wire protocol, or its
 * credentials.
 */

import { resolveStreamingTranscriber } from "../providers/speech-to-text/resolve.js";
import type { StreamingTranscriber } from "../stt/types.js";

/**
 * Open a streaming transcription session against the configured STT provider
 * (`services.stt.provider`).
 *
 * Returns a live {@link StreamingTranscriber} the caller drives with
 * `start` / `sendAudio` / `stop`, or `null` when no streaming session can be
 * opened — the provider is unknown, has no streaming adapter, or is missing
 * credentials.
 */
export function openTranscriptionSession(): Promise<StreamingTranscriber | null> {
  return resolveStreamingTranscriber();
}
