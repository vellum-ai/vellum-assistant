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

import type { StreamingTranscriber } from "../stt/types.js";

/**
 * Open a streaming transcription session against the configured STT provider
 * (`services.stt.provider`).
 *
 * Returns a live {@link StreamingTranscriber} the caller drives with
 * `start` / `sendAudio` / `stop`, or `null` when no streaming session can be
 * opened — the provider is unknown, has no streaming adapter, or is missing
 * credentials.
 *
 * The STT resolver is imported lazily at call time, mirroring
 * `runConversationTurn`: plugin-api facades must not statically pull deep
 * daemon subsystems into the barrel's module graph. The static import here
 * dragged ~75 provider/STT modules into `plugin-api/index.ts` evaluation,
 * and in the compiled binary that surfaced as a TDZ `ReferenceError`
 * ("Cannot access 'openTranscriptionSession' before initialization") when a
 * plugin touched the binding through the workspace shim. With the lazy
 * import this module has no static value imports at all, so the barrel
 * binding initializes trivially and the daemon graph loads on first use.
 */
export async function openTranscriptionSession(): Promise<StreamingTranscriber | null> {
  const { resolveStreamingTranscriber } =
    await import("../providers/speech-to-text/resolve.js");
  return resolveStreamingTranscriber();
}
