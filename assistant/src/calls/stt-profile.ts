/**
 * Telephony STT profile adapter.
 *
 * Centralizes the mapping from config-level STT settings
 * (`calls.voice.transcriptionProvider`, `calls.voice.speechModel`) to a
 * normalized profile object consumed by call infrastructure.
 *
 * Provider-specific semantics:
 * - **Deepgram**: defaults speechModel to `"nova-3"` when unset.
 * - **Google**: leaves speechModel undefined when unset (Google's Cloud Speech
 *   API uses its own default). Treats the legacy Deepgram default `"nova-3"`
 *   as unset — upgraded workspaces may still have it persisted from prior
 *   defaults before provider was switched.
 */

import type { CallsVoiceConfig } from "../config/schemas/calls.js";

/**
 * Provider-agnostic representation of the telephony STT configuration.
 */
export interface TelephonySttProfile {
  /** STT provider name as expected by the telephony platform (e.g. "Deepgram", "Google"). */
  provider: string;
  /** ASR model identifier, or undefined to let the provider use its default. */
  speechModel: string | undefined;
}

const DEEPGRAM_DEFAULT_SPEECH_MODEL = "nova-3";

/**
 * Resolve a normalized telephony STT profile from the calls voice config.
 *
 * This is the single source of truth for STT provider selection in the
 * telephony call path. All call-related code should read STT details from
 * the returned profile rather than branching on provider inline.
 */
export function resolveTelephonySttProfile(
  voiceConfig: Pick<CallsVoiceConfig, "transcriptionProvider" | "speechModel">,
): TelephonySttProfile {
  const provider = voiceConfig.transcriptionProvider;
  const rawSpeechModel = voiceConfig.speechModel;

  return {
    provider,
    speechModel: resolveEffectiveSpeechModel(provider, rawSpeechModel),
  };
}

/**
 * Determine the effective speech model for the given provider.
 *
 * - Deepgram: fall back to "nova-3" when the model is not explicitly set.
 * - Google: treat the legacy Deepgram default ("nova-3") as unset so that
 *   workspaces that were previously configured for Deepgram and later
 *   switched to Google don't inadvertently send a Deepgram model name.
 */
function resolveEffectiveSpeechModel(
  provider: string,
  rawSpeechModel: string | undefined,
): string | undefined {
  const isGoogle = provider === "Google";

  if (rawSpeechModel == null) {
    return isGoogle ? undefined : DEEPGRAM_DEFAULT_SPEECH_MODEL;
  }

  // Legacy migration: if the persisted model is the Deepgram default but
  // the provider has been switched to Google, treat it as unset.
  if (rawSpeechModel === DEEPGRAM_DEFAULT_SPEECH_MODEL && isGoogle) {
    return undefined;
  }

  return rawSpeechModel;
}
