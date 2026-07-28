import { normalizeActivationKey } from "../../../../daemon/handlers/config-voice.js";
import { managedSpeechAvailable } from "../../../../platform/managed-speech.js";
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
};

function validateSetting(
  setting: string,
  value: unknown,
  activeTtsProviderId?: string,
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

  const validation = validateSetting(setting, value, activeTtsProviderId);
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

  const broadcastNote =
    meta.userDefaultsKey && !skipClientBroadcast
      ? " The change has been broadcast to the desktop client."
      : "";
  return {
    content: `${friendlyName} updated to ${JSON.stringify(
      validation.coerced,
    )}.${broadcastNote}`,
    isError: false,
  };
}
