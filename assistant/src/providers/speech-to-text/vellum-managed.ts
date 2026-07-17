/**
 * Vellum-managed batch STT: transcription through the platform's managed
 * speech endpoint (Vellum-held Deepgram key, billed to Vellum credits). No
 * provider API key exists on this machine — availability is the platform
 * connection itself.
 */

import {
  managedSpeechAvailable,
  type ManagedSpeechResult,
  managedSpeechTranscribe,
} from "../../platform/managed-speech.js";
import {
  SttError,
  type SttErrorCategory,
  type SttTranscribeResult,
} from "../../stt/types.js";

type ManagedSpeechFailure = Extract<ManagedSpeechResult<never>, { ok: false }>;

/**
 * Whether managed speech can be used at all: a platform connection with a
 * platform assistant ID. The credential-store lookup used for API-key
 * providers does not apply to `vellum`.
 */
export async function vellumManagedSpeechAvailable(): Promise<boolean> {
  return managedSpeechAvailable();
}

/**
 * Map a managed-speech failure onto the normalized STT error categories.
 *
 * `insufficient_balance` gets a user-actionable message — the fix is topping
 * up Vellum credits, not editing provider config.
 *
 * Every returned error is flagged `userFacing`: managed speech has no provider
 * API key on this machine, so the messages here (reconnect the platform,
 * top up credits, the platform's own detail) already carry the correct
 * remediation. `describeSttFailure` surfaces them verbatim instead of
 * rewriting to the BYOK "check your API key" copy that never applies.
 */
export function sttErrorFromManagedSpeech(
  failure: ManagedSpeechFailure,
): SttError {
  const managed = (category: SttErrorCategory, message: string): SttError =>
    new SttError(category, message, { userFacing: true });

  if (failure.kind === "unavailable") {
    return managed("auth", failure.message);
  }
  if (failure.code === "insufficient_balance") {
    return managed(
      "provider-error",
      "Vellum credits are exhausted — add funds to your Vellum account to continue using managed transcription.",
    );
  }
  switch (failure.status) {
    case 401:
    case 403:
      return managed("auth", failure.message);
    case 429:
      return managed("rate-limit", failure.message);
    case 413:
      return managed("invalid-audio", failure.message);
    default:
      return managed("provider-error", failure.message);
  }
}

/**
 * Transcribe a complete audio buffer via the platform. Throws {@link SttError}
 * on failure (already normalized — `normalizeSttError` passes it through).
 */
export async function vellumManagedTranscribe(
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<SttTranscribeResult> {
  const result = await managedSpeechTranscribe({ audio, mimeType, signal });
  if (!result.ok) {
    throw sttErrorFromManagedSpeech(result);
  }
  return { text: result.value.text };
}
