import { normalizeActivationKey } from "../../../../daemon/handlers/config-voice.js";
import { managedSpeechAvailable } from "../../../../platform/managed-speech.js";
import {
  DEEPGRAM_MULTI_LANGUAGE_CODES,
  DEEPGRAM_NOVA3_MONOLINGUAL_CODES,
} from "../../../../providers/speech-to-text/deepgram.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { listCatalogProviderIds } from "../../../../tts/provider-catalog.js";
import { ttsVoiceFieldFor } from "../../../../tts/tts-voice-field.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../loader.js";
import { VALID_CONVERSATION_TIMEOUTS } from "../../../schemas/elevenlabs.js";
import { VALID_STT_PROVIDERS } from "../../../schemas/stt.js";

/**
 * Valid voice config settings and their UserDefaults key mappings.
 *
 * All config paths are canonical (`services.tts.*` / `services.stt.*`).
 * Settings without a userDefaultsKey are daemon-config-only and are not
 * broadcast to the desktop client.
 */
type VoiceSettingMeta = { userDefaultsKey?: string; type: "string" | "number" };

const VOICE_SETTINGS = {
  activation_key: {
    userDefaultsKey: "pttActivationKey",
    type: "string",
  },
  conversation_timeout: {
    userDefaultsKey: "voiceConversationTimeoutSeconds",
    type: "number",
  },
  tts_provider: { userDefaultsKey: "ttsProvider", type: "string" },
  tts_voice_id: { userDefaultsKey: "ttsVoiceId", type: "string" },
  fish_audio_reference_id: {
    userDefaultsKey: "fishAudioReferenceId",
    type: "string",
  },
  stt_provider: { type: "string" },
  stt_language: { type: "string" },
} satisfies Record<string, VoiceSettingMeta>;

type VoiceSettingName = keyof typeof VOICE_SETTINGS;

/** Exported so tests can assert parity with the TOOLS.json `setting` enum. */
export const VALID_SETTINGS = Object.keys(VOICE_SETTINGS) as VoiceSettingName[];

const VALID_TIMEOUTS: readonly number[] = VALID_CONVERSATION_TIMEOUTS;

const FRIENDLY_NAMES: Record<VoiceSettingName, string> = {
  activation_key: "PTT activation key",
  conversation_timeout: "Conversation timeout",
  tts_provider: "TTS provider",
  tts_voice_id: "ElevenLabs voice",
  fish_audio_reference_id: "Fish Audio voice",
  stt_provider: "Speech-to-text provider",
  stt_language: "Speech-to-text language",
};

/**
 * Curated spoken-language codes for `services.stt.language`: the verified
 * Deepgram nova-3 monolingual roster plus `multi` itself, derived from the
 * daemon's single roster source (`DEEPGRAM_NOVA3_MONOLINGUAL_CODES`, which
 * the web settings catalog mirrors under a parity test). The config schema
 * accepts any non-empty string, but this tool only offers the curated set so
 * a conversational request cannot persist an unvalidated code.
 */
const VALID_STT_LANGUAGES = [
  ...DEEPGRAM_NOVA3_MONOLINGUAL_CODES,
  "multi",
] as const;

/**
 * Codes accepted when the effective STT provider is xai: the pre-expansion
 * multi-roster monolinguals (which include "en"), the set xAI was verified
 * with. The extended nova-3 codes are verified against Deepgram's docs only,
 * and "multi" is a Deepgram nova-3 mode the resolver never forwards to xAI,
 * so both are rejected here rather than persisted as unverified or dead
 * values. Derived from the daemon's roster source, same as the web catalog's
 * provider scoping (`sttLanguageOptionsFor`).
 */
const XAI_STT_LANGUAGES: readonly string[] = DEEPGRAM_MULTI_LANGUAGE_CODES;

/**
 * Rejection copy when a roster code is valid in general but not for xai. It
 * names the provider and the accepted set so the model can steer the user
 * instead of retrying blindly.
 */
const XAI_STT_LANGUAGE_ERROR = `the configured STT provider is xai, which supports: ${XAI_STT_LANGUAGES.join(
  ", ",
)}. Multilingual (multi) and the extended language codes are Deepgram/managed (vellum) only; switch stt_provider to use them`;

/**
 * STT providers that auto-detect the spoken language natively and take no
 * language parameter (the resolver's value is ignored). A language write is
 * still allowed for them (it applies after a later provider switch), but the
 * success message notes the setting has no effect while they are active.
 */
const AUTO_DETECT_STT_PROVIDERS: ReadonlySet<string> = new Set([
  "google-gemini",
  "openai-whisper",
]);

/**
 * Rejection copy for stt_language. The roster is too long to enumerate in an
 * error message, so it names the count and a few examples; the full set is
 * `VALID_STT_LANGUAGES`.
 */
const STT_LANGUAGE_ERROR = `stt_language must be one of the ${VALID_STT_LANGUAGES.length - 1} supported language codes (e.g. en, es, hi, ta, zh, ko) or multi for code-switching; language names like "hindi", "tamil", and "multilingual" are also accepted`;

/**
 * Forgiving aliases normalized (after trim + lowercase) to a curated code, so
 * a natural value like "Hindi" or "multilingual" is accepted rather than
 * rejected. Mirrors the alias treatment stt_provider gets in the config
 * schema (openai/whisper -> openai-whisper). Common alternate names map to
 * the same code (mandarin -> zh, farsi -> fa, filipino -> tl).
 */
const STT_LANGUAGE_ALIASES: Record<
  string,
  (typeof VALID_STT_LANGUAGES)[number]
> = {
  arabic: "ar",
  belarusian: "be",
  bengali: "bn",
  bangla: "bn",
  bosnian: "bs",
  bulgarian: "bg",
  catalan: "ca",
  chinese: "zh",
  mandarin: "zh",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  finnish: "fi",
  french: "fr",
  german: "de",
  greek: "el",
  gujarati: "gu",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  kannada: "kn",
  korean: "ko",
  latvian: "lv",
  lithuanian: "lt",
  macedonian: "mk",
  malay: "ms",
  marathi: "mr",
  norwegian: "no",
  persian: "fa",
  farsi: "fa",
  polish: "pl",
  portuguese: "pt",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swedish: "sv",
  tagalog: "tl",
  filipino: "tl",
  tamil: "ta",
  telugu: "te",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  vietnamese: "vi",
  multilingual: "multi",
  auto: "multi",
  mixed: "multi",
  "code-switching": "multi",
};

function validateSetting(
  setting: string,
  value: unknown,
  activeTtsProviderId?: string,
  activeSttProviderId?: string,
):
  | { ok: true; coerced: string | boolean | number }
  | { ok: false; error: string } {
  if (!VALID_SETTINGS.includes(setting as VoiceSettingName)) {
    return {
      ok: false,
      error: `Unknown setting "${setting}". Valid settings: ${VALID_SETTINGS.join(
        ", ",
      )}`,
    };
  }

  switch (setting) {
    case "activation_key": {
      if (typeof value !== "string" || value.length === 0) {
        return {
          ok: false,
          error: "activation_key must be a non-empty string",
        };
      }
      const result = normalizeActivationKey(value);
      if (!result.ok) {
        return { ok: false, error: result.reason };
      }
      return { ok: true, coerced: result.value };
    }
    case "conversation_timeout": {
      const num = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(num) || !VALID_TIMEOUTS.includes(num)) {
        return {
          ok: false,
          error: `conversation_timeout must be one of: ${VALID_TIMEOUTS.join(
            ", ",
          )}`,
        };
      }
      return { ok: true, coerced: num };
    }
    case "tts_voice_id": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          ok: false,
          error: "tts_voice_id must be a non-empty string",
        };
      }
      const trimmed = value.trim();
      const field = ttsVoiceFieldFor(activeTtsProviderId);
      if (field.alphanumericOnly) {
        if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
          return {
            ok: false,
            error:
              "tts_voice_id must contain only alphanumeric characters (ElevenLabs voice ID format)",
          };
        }
      } else if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        // Managed (vellum) / deepgram voices are Deepgram Aura model ids and
        // the other providers' voice references are also hyphenated.
        return {
          ok: false,
          error:
            "tts_voice_id must contain only letters, numbers, '.', '_', or '-' " +
            "(e.g. a Deepgram Aura model id like aura-2-thalia-en)",
        };
      }
      return { ok: true, coerced: trimmed };
    }
    case "tts_provider": {
      const catalogIds: readonly string[] = listCatalogProviderIds();
      if (typeof value !== "string" || !catalogIds.includes(value.trim())) {
        return {
          ok: false,
          error: `tts_provider must be one of: ${catalogIds.join(", ")}`,
        };
      }
      return { ok: true, coerced: value.trim() };
    }
    case "stt_provider": {
      const sttIds: readonly string[] = VALID_STT_PROVIDERS;
      if (typeof value !== "string" || !sttIds.includes(value.trim())) {
        return {
          ok: false,
          error: `stt_provider must be one of: ${sttIds.join(", ")}`,
        };
      }
      return { ok: true, coerced: value.trim() };
    }
    case "stt_language": {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: STT_LANGUAGE_ERROR,
        };
      }
      const normalized = value.trim().toLowerCase();
      const coerced = STT_LANGUAGE_ALIASES[normalized] ?? normalized;
      if (!(VALID_STT_LANGUAGES as readonly string[]).includes(coerced)) {
        return {
          ok: false,
          error: STT_LANGUAGE_ERROR,
        };
      }
      // Provider scoping, after alias normalization so "Tamil" and "ta" fail
      // the same way: the extended roster and "multi" are verified for
      // Deepgram nova-3 (BYOK deepgram and the managed relay) only. Under
      // xai, persisting them would mean every web surface withholds the code
      // while the resolver forwards it unverified (or, for "multi", drops it
      // silently), so the write is an honest rejection instead. Auto-detect
      // providers keep the unconditional write (the value applies after a
      // later provider switch); the success message carries the caveat.
      if (
        activeSttProviderId === "xai" &&
        !XAI_STT_LANGUAGES.includes(coerced)
      ) {
        return { ok: false, error: XAI_STT_LANGUAGE_ERROR };
      }
      return { ok: true, coerced };
    }
    case "fish_audio_reference_id": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          ok: false,
          error: "fish_audio_reference_id must be a non-empty string",
        };
      }
      return { ok: true, coerced: value.trim() };
    }
    default:
      return { ok: false, error: `Unknown setting "${setting}"` };
  }
}

/**
 * Remove a legacy `mode` key from a raw `services.<svc>` block. The schema
 * no longer has the field, but the settings cards still write it (for
 * compatibility with older daemons) and read `mode: "managed"` as the
 * Vellum marker — left stale after a provider switch here, the cards would
 * render Vellum while the daemon routes the newly chosen provider.
 */
function deleteLegacySpeechMode(
  raw: Record<string, unknown>,
  svc: "stt" | "tts",
): void {
  const services = raw.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    return;
  }
  const entry = (services as Record<string, unknown>)[svc];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return;
  }
  delete (entry as Record<string, unknown>).mode;
}

/**
 * Whether a raw `services.stt` block already names a provider, walking the
 * raw shape with the same defensive guards as {@link deleteLegacySpeechMode}
 * (the raw file is untrusted JSON, not schema output).
 */
function rawSttProviderPresent(raw: Record<string, unknown>): boolean {
  const services = raw.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    return false;
  }
  const stt = (services as Record<string, unknown>).stt;
  if (!stt || typeof stt !== "object" || Array.isArray(stt)) {
    return false;
  }
  const provider = (stt as Record<string, unknown>).provider;
  return typeof provider === "string" && provider.trim().length > 0;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const setting = input.setting as string | undefined;
  const value = input.value;

  if (!setting) {
    return {
      content: `Error: "setting" is required. Valid settings: ${VALID_SETTINGS.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  if (value === undefined) {
    return {
      content: `Error: "value" is required for setting "${setting}".`,
      isError: true,
    };
  }

  // A tts_voice_id change targets the *active* TTS provider's voice field, so
  // validation and the write below both need to know which provider is live.
  const activeTtsProviderId =
    setting === "tts_voice_id" ? getConfig().services.tts.provider : undefined;

  // An stt_language change is scoped by the *effective* STT provider (the
  // same source the sparse-config write-seeding below reads): the extended
  // roster and "multi" are only valid where nova-3 runs.
  const activeSttProviderId =
    setting === "stt_language" ? getConfig().services.stt.provider : undefined;

  const validation = validateSetting(
    setting,
    value,
    activeTtsProviderId,
    activeSttProviderId,
  );
  if (!validation.ok) {
    return { content: `Error: ${validation.error}`, isError: true };
  }

  const wantsManagedSpeech =
    (setting === "stt_provider" || setting === "tts_provider") &&
    validation.coerced === "vellum";
  if (wantsManagedSpeech && !(await managedSpeechAvailable())) {
    return {
      content:
        "Error: managed speech requires a Vellum platform connection. Run 'assistant platform connect' first.",
      isError: true,
    };
  }

  const meta: VoiceSettingMeta = VOICE_SETTINGS[setting as VoiceSettingName];
  const friendlyName =
    setting === "tts_voice_id"
      ? ttsVoiceFieldFor(activeTtsProviderId).label
      : FRIENDLY_NAMES[setting as VoiceSettingName];

  // The `ttsVoiceId` UserDefaults key is an ElevenLabs concept on the desktop
  // client. A managed (vellum) or other-provider voice lives only in daemon
  // config and hot-applies per turn — broadcasting its id under the ElevenLabs
  // key would pollute the client's ElevenLabs voice, so skip the broadcast.
  const skipClientBroadcast =
    setting === "tts_voice_id" && activeTtsProviderId !== "elevenlabs";

  // Send client_settings_update message to write to UserDefaults.
  // Always stringify the value — Swift's ClientSettingsUpdate.value is typed
  // as String, so a bare JSON number would fail to decode.
  if (context.sendToClient && meta.userDefaultsKey && !skipClientBroadcast) {
    context.sendToClient({
      type: "client_settings_update",
      key: meta.userDefaultsKey,
      value: String(validation.coerced),
    });
  }

  // Persist to canonical config paths under services.tts.*
  const raw = loadRawConfig();

  if (setting === "tts_provider") {
    setNestedValue(raw, "services.tts.provider", validation.coerced);
    deleteLegacySpeechMode(raw, "tts");
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "tts_voice_id") {
    setNestedValue(
      raw,
      ttsVoiceFieldFor(activeTtsProviderId).path,
      validation.coerced,
    );
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "conversation_timeout") {
    setNestedValue(
      raw,
      "services.tts.providers.elevenlabs.conversationTimeoutSeconds",
      validation.coerced,
    );
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "fish_audio_reference_id") {
    setNestedValue(
      raw,
      "services.tts.providers.fish-audio.referenceId",
      validation.coerced,
    );
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "stt_provider") {
    setNestedValue(raw, "services.stt.provider", validation.coerced);
    deleteLegacySpeechMode(raw, "stt");
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  // Provider scoping happened in validation (xai only accepts its verified
  // set); for the remaining providers the write is unconditional. Auto-detect
  // providers ignore the value at resolve time, so writing it is harmless and
  // the success note below says so, matching how stt_provider does not
  // cross-validate credentials.
  if (setting === "stt_language") {
    // A sparse raw config may lack `services.stt.provider` entirely. Writing
    // only the language would persist `{ stt: { language } }`, and
    // SttServiceSchema requires `provider` (the services-level default fills
    // it only when `services.stt` is wholly absent), so the block would fail
    // validation and trip the loader's salvage ladder: the language never
    // applies and the whole `services` section (including unrelated TTS
    // settings) can reset to defaults (the LUM-2758 failure family). Like the
    // schema's alias preprocessing and this tool's curated-value validation,
    // keep the write self-consistent: seed the provider from the effective
    // config in the same write.
    if (!rawSttProviderPresent(raw)) {
      setNestedValue(
        raw,
        "services.stt.provider",
        getConfig().services.stt.provider,
      );
    }
    setNestedValue(raw, "services.stt.language", validation.coerced);
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  const broadcastNote =
    meta.userDefaultsKey && !skipClientBroadcast
      ? " The change has been broadcast to the desktop client."
      : "";
  // A language written while an auto-detecting provider is active persists
  // but has no effect until the provider changes; say so in the same
  // provider-aware voice the tool description uses.
  const autoDetectNote =
    activeSttProviderId !== undefined &&
    AUTO_DETECT_STT_PROVIDERS.has(activeSttProviderId)
      ? ` Note: the configured STT provider (${activeSttProviderId}) auto-detects the spoken language natively and ignores this setting.`
      : "";
  return {
    content: `${friendlyName} updated to ${JSON.stringify(
      validation.coerced,
    )}.${broadcastNote}${autoDetectNote}`,
    isError: false,
  };
}
