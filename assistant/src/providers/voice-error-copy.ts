/**
 * Single source of truth for user- and model-facing voice (STT/TTS) failure
 * copy. Provider adapters reject with raw upstream bodies (kept in logs only);
 * these helpers turn a normalized error into friendly, actionable text that
 * never leaks raw JSON or HTTP status noise into a conversation or the UI.
 */

import type { SttError, SttProviderId } from "../stt/types.js";
import { getProviderEntry } from "./speech-to-text/provider-catalog.js";

function sttProviderLabel(providerId?: SttProviderId): string {
  const displayName = providerId
    ? getProviderEntry(providerId)?.displayName
    : undefined;
  return displayName ?? "the speech-to-text provider";
}

/**
 * Friendly, model-actionable copy for a normalized STT failure. Names the
 * provider (when known) so the model can point the user at the right fix.
 */
export function describeSttFailure(
  err: SttError,
  providerId?: SttProviderId,
): string {
  const provider = sttProviderLabel(providerId);
  switch (err.category) {
    case "auth":
      return `${provider} rejected the configured API key — it may be expired or invalid. Check the speech-to-text API key in Settings → Voice.`;
    case "rate-limit":
      return `${provider} is rate-limiting transcription requests right now. Try again shortly.`;
    case "timeout":
      return "Transcription timed out.";
    case "invalid-audio":
      return "The audio could not be transcribed (unsupported or corrupted format).";
    default:
      return `${provider} returned an error while transcribing.`;
  }
}

/**
 * Friendly copy for a TTS authentication failure (HTTP 401/403). Shared with
 * the STT auth copy's "check the API key in Settings → Voice" guidance.
 */
export function describeTtsAuthFailure(providerDisplayName: string): string {
  return `${providerDisplayName} rejected the configured API key (authentication failed) — check the ${providerDisplayName} API key in Settings → Voice.`;
}
