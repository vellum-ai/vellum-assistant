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
 * Managed speech has no provider API key on this machine, so the BYOK "check
 * your API key" rewrite never applies. A failure is flagged `userFacing` —
 * surfaced verbatim by `describeSttFailure` — when it carries actionable
 * remediation: a platform reconnect (`unavailable`), a credit top-up
 * (`insufficient_balance`), or the platform's own `detail` message. A failure
 * that fell back to a bare HTTP status (no `detail`) is left non-user-facing so
 * `describeSttFailure` emits friendly category copy instead of leaking the raw
 * status — except a bare auth status (401/403), which would be rewritten to the
 * wrong BYOK "check your API key" guidance, so it gets its own sanitized
 * platform-connection message.
 */
export function sttErrorFromManagedSpeech(
  failure: ManagedSpeechFailure,
): SttError {
  const hasDetail = failure.detail !== undefined;
  const userFacing =
    failure.kind === "unavailable" ||
    failure.code === "insufficient_balance" ||
    hasDetail;
  const managed = (category: SttErrorCategory, message: string): SttError =>
    new SttError(category, message, { userFacing });

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
      // A bare auth failure must stay user-facing so describeSttFailure skips
      // its BYOK "check your API key" rewrite — managed STT has no local key.
      // `managed()` would be non-user-facing here (see `userFacing` above), so
      // construct the sanitized platform-connection message directly.
      return hasDetail
        ? managed("auth", failure.message)
        : new SttError(
            "auth",
            "Vellum couldn't authenticate with the platform while transcribing — reconnect your Vellum account, then retry.",
            { userFacing: true },
          );
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
