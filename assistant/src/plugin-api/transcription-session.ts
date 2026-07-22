/**
 * Plugin-facing facade for opening a streaming speech-to-text session against
 * the assistant's configured STT provider stack.
 *
 * A session is the streaming counterpart to the stateless `synthesizeText`
 * (TTS) helper: the plugin feeds raw audio chunks in and receives partial and
 * final transcript events back over a callback. The consumer drives it through
 * a minimal three-method contract — {@link StreamingTranscriber.start},
 * {@link StreamingTranscriber.sendAudio}, and {@link StreamingTranscriber.stop}
 * — so a plugin (e.g. a meeting bot piping PCM frames captured from a call)
 * needs no knowledge of the concrete provider (Deepgram, Whisper, Gemini, xAI,
 * or Vellum-managed speech), its wire protocol, or its credentials.
 *
 * ## Child-process safety
 *
 * The session is deliberately singleton-free: it resolves the provider and its
 * credentials from process-local state only — the workspace config on disk
 * (`services.stt.provider`) and the credential store over the CES socket — and
 * the returned session dials the provider directly. It does **not** touch any
 * in-daemon singleton (the live-voice session manager, the WebSocket session
 * registry, or the event hub). A plugin can therefore open a session from a
 * spawned child process, not just from the daemon process, as long as that
 * process inherits the workspace directory and can reach the credential store.
 *
 * Prefer this over reaching for the daemon's WebSocket STT session
 * orchestrator: that path is bound to a client socket and the daemon-wide
 * active-session registry, neither of which exists in a child process.
 */

import type {
  StreamingTranscriber,
  SttProviderId,
} from "../stt/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenTranscriptionSessionOptions {
  /**
   * Sample rate (Hz) of the PCM audio the plugin will feed. Passed through to
   * the provider adapter so it decodes at the right rate. Supply this whenever
   * the audio is raw PCM (e.g. `audio/pcm`) — a mismatch produces garbled
   * transcripts. Ignored for container formats that carry their own rate.
   */
  sampleRate?: number;
  /**
   * Speaker diarization preference. Default: `"off"`.
   *
   * - `"off"` — never request speaker labels.
   * - `"preferred"` — request diarization when the configured provider supports
   *   it; proceed without it otherwise.
   * - `"required"` — require diarization; resolve to `null` when the configured
   *   provider cannot diarize, so the caller can surface a clear error.
   */
  diarize?: "off" | "preferred" | "required";
  /**
   * Provider to open a session for. Defaults to `services.stt.provider` from
   * the workspace config. Supply this only when the plugin has independently
   * determined the effective provider and wants the session to match it.
   */
  providerId?: SttProviderId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a streaming transcription session against the configured STT provider.
 *
 * Resolves the provider from the workspace config (or `options.providerId`),
 * verifies it supports daemon-streaming transcription, and looks up its
 * credentials — then returns a live {@link StreamingTranscriber} the caller
 * drives with `start` / `sendAudio` / `stop`.
 *
 * Returns `null` when no streaming session can be opened, i.e. the resolved
 * provider is unknown, lacks a streaming adapter, has no credentials, or
 * cannot satisfy a `diarize: "required"` request. Callers that want to explain
 * the gap can list the eligible providers with
 * {@link listStreamingTranscriptionProviderIds}.
 */
export async function openTranscriptionSession(
  options: OpenTranscriptionSessionOptions = {},
): Promise<StreamingTranscriber | null> {
  const { resolveStreamingTranscriber } = await import(
    "../providers/speech-to-text/resolve.js"
  );
  return resolveStreamingTranscriber({
    ...(options.sampleRate !== undefined
      ? { sampleRate: options.sampleRate }
      : {}),
    ...(options.diarize !== undefined ? { diarize: options.diarize } : {}),
    ...(options.providerId !== undefined
      ? { providerId: options.providerId }
      : {}),
  });
}

/**
 * List the STT provider IDs that support daemon-streaming transcription, in
 * catalog order. A session can only be opened for one of these (and only when
 * its credentials are present), so callers use this to build a remediation
 * message when {@link openTranscriptionSession} returns `null` — e.g. "set
 * services.stt.provider to one of: …".
 */
export async function listStreamingTranscriptionProviderIds(): Promise<
  SttProviderId[]
> {
  const { listProviderIds, supportsBoundary } = await import(
    "../providers/speech-to-text/provider-catalog.js"
  );
  return listProviderIds().filter((id) =>
    supportsBoundary(id, "daemon-streaming"),
  );
}
