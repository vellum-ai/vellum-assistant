/**
 * Synthesis-language resolution for telephony TTS.
 *
 * The telephony call-control prompt instructs the model to speak the
 * caller's language; this resolver produces the matching TTS hint so
 * providers that can enforce a language render the reply in it (the hint
 * is a no-op for providers that cannot). Resolution mirrors live voice's
 * turn language (live-voice-session.ts): the dominant STT-detected
 * language when the transcriber tags finals, else a monolingual
 * `services.stt.language` pin when the configured provider honors manual
 * language selection, else undefined (no hint, provider default behavior).
 */

import { getConfig } from "../config/loader.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import { normalizeLanguageTag } from "../stt/language-metadata.js";
import type { SttProviderId } from "../stt/types.js";

/**
 * Resolve the language hint for telephony synthesis as a lowercase base
 * subtag, or undefined when no signal resolves.
 *
 * @param detectedLanguage - The STT session's detected dominant caller
 *   language, when a session is reachable from the call site. Wins over
 *   the pin whenever it normalizes to a non-empty tag.
 */
export function resolveTelephonySynthesisLanguage(
  detectedLanguage?: string,
): string | undefined {
  if (detectedLanguage !== undefined) {
    const normalized = normalizeLanguageTag(detectedLanguage);
    if (normalized) {
      return normalized;
    }
  }

  let stt: { provider: string; language?: string };
  try {
    stt = getConfig().services.stt;
  } catch {
    // Config unavailable (early startup, minimal test workspaces): no hint.
    return undefined;
  }

  // A persisted pin only counts when the configured provider honors manual
  // language selection: auto-detecting providers (gemini, whisper) ignore
  // the setting entirely, so treating it as the caller's language would
  // force every call into a stale pin. Same gate as the pre-speech prompt
  // rule (voice-session-bridge.ts) and live voice's turnLanguageFor.
  const providerHonorsLanguagePin =
    getProviderEntry(stt.provider as SttProviderId)?.languageSelection ===
    "manual";
  const configured = stt.language?.trim();
  if (!providerHonorsLanguagePin || !configured || configured === "multi") {
    return undefined;
  }
  const normalized = normalizeLanguageTag(configured);
  return normalized || undefined;
}
