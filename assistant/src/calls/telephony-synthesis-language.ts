/**
 * Synthesis-language resolution for telephony TTS.
 *
 * The telephony call-control prompt instructs the model to speak the
 * caller's language; this resolver produces the matching TTS hint so
 * providers that can enforce a language render the reply in it (the hint
 * is a no-op for providers that cannot). Resolution mirrors live voice's
 * per-utterance turn language (live-voice-session.ts): the caller's
 * latest STT-detected language when the transcriber tags finals, else a
 * monolingual `services.stt.language` pin when the configured provider
 * honors manual language selection, else undefined (no hint, provider
 * default behavior).
 */

import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { pinnedListeningLanguage } from "../providers/speech-to-text/provider-catalog.js";
import { resolveLanguageVoiceOverride } from "../tts/language-voices.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProviderId } from "../tts/types.js";
import { baseLanguageSubtag } from "../util/language-subtag.js";

/**
 * Resolve the language hint for telephony synthesis as a lowercase base
 * subtag, or undefined when no signal resolves.
 *
 * @param detectedLanguage - The caller language the STT session detected
 *   on its latest tagged utterance, when a session is reachable from the
 *   call site. Wins over the pin whenever it normalizes to a non-empty
 *   tag.
 */
export function resolveTelephonySynthesisLanguage(
  detectedLanguage?: string,
): string | undefined {
  const detected = baseLanguageSubtag(detectedLanguage);
  if (detected !== undefined) {
    return detected;
  }

  let stt: { provider: string; language?: string };
  try {
    stt = getConfig().services.stt;
  } catch {
    // Config unavailable (early startup, minimal test workspaces): no hint.
    return undefined;
  }

  return pinnedListeningLanguage(stt.provider, stt.language);
}

/**
 * Resolve the per-language voice for a telephony synthesis request from
 * the synthesizing provider's `services.tts.providers.<id>.languageVoices`
 * map. Keyed by the provider actually synthesizing, which on the
 * media-stream transport may be a playability fallback rather than the
 * configured provider, because voice identifiers are provider-specific.
 * Returns undefined (provider default voice) when the request carries no
 * language, config is unavailable, or the provider's map has no entry.
 */
export function resolveTelephonyLanguageVoice(
  providerId: string,
  language: string | undefined,
): string | undefined {
  if (language === undefined) {
    return undefined;
  }

  let config: AssistantConfig;
  try {
    config = getConfig();
  } catch {
    // Config unavailable (early startup, minimal test workspaces): no override.
    return undefined;
  }

  const { providerConfig } = resolveTtsConfig(
    config,
    providerId as TtsProviderId,
  );
  return resolveLanguageVoiceOverride(
    providerConfig.languageVoices as Record<string, string> | undefined,
    language,
  );
}
