import { normalizeActivationKey } from "../../../../daemon/handlers/config-voice.js";
import { managedSpeechAvailable } from "../../../../platform/managed-speech.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { listCatalogProviderIds } from "../../../../tts/provider-catalog.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../loader.js";
import { VALID_CONVERSATION_TIMEOUTS } from "../../../schemas/elevenlabs.js";

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
  stt_mode: { type: "string" },
  tts_mode: { type: "string" },
} satisfies Record<string, VoiceSettingMeta>;

type VoiceSettingName = keyof typeof VOICE_SETTINGS;

const VALID_SETTINGS = Object.keys(VOICE_SETTINGS) as VoiceSettingName[];

const VALID_TIMEOUTS: readonly number[] = VALID_CONVERSATION_TIMEOUTS;

const FRIENDLY_NAMES: Record<VoiceSettingName, string> = {
  activation_key: "PTT activation key",
  conversation_timeout: "Conversation timeout",
  tts_provider: "TTS provider",
  tts_voice_id: "ElevenLabs voice",
  fish_audio_reference_id: "Fish Audio voice",
  stt_mode: "Speech-to-text mode",
  tts_mode: "Text-to-speech mode",
};

const VALID_SPEECH_MODES = ["your-own", "managed"] as const;

function validateSetting(
  setting: string,
  value: unknown,
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
          error:
            "tts_voice_id must be a non-empty string (ElevenLabs voice ID)",
        };
      }
      const trimmed = value.trim();
      if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
        return {
          ok: false,
          error:
            "tts_voice_id must contain only alphanumeric characters (ElevenLabs voice ID format)",
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
    case "stt_mode":
    case "tts_mode": {
      if (
        typeof value !== "string" ||
        !VALID_SPEECH_MODES.includes(
          value.trim() as (typeof VALID_SPEECH_MODES)[number],
        )
      ) {
        return {
          ok: false,
          error: `${setting} must be one of: ${VALID_SPEECH_MODES.join(", ")}`,
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

  const validation = validateSetting(setting, value);
  if (!validation.ok) {
    return { content: `Error: ${validation.error}`, isError: true };
  }

  if (
    (setting === "stt_mode" || setting === "tts_mode") &&
    validation.coerced === "managed" &&
    !(await managedSpeechAvailable())
  ) {
    return {
      content:
        "Error: managed speech requires a Vellum platform connection. Run 'assistant platform connect' first.",
      isError: true,
    };
  }

  const meta: VoiceSettingMeta = VOICE_SETTINGS[setting as VoiceSettingName];
  const friendlyName = FRIENDLY_NAMES[setting as VoiceSettingName];

  // Send client_settings_update message to write to UserDefaults.
  // Always stringify the value — Swift's ClientSettingsUpdate.value is typed
  // as String, so a bare JSON number would fail to decode.
  if (context.sendToClient && meta.userDefaultsKey) {
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
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "tts_voice_id") {
    setNestedValue(
      raw,
      "services.tts.providers.elevenlabs.voiceId",
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

  if (setting === "stt_mode") {
    setNestedValue(raw, "services.stt.mode", validation.coerced);
    // SttServiceSchema requires `provider` whenever the stt object exists and
    // forbids provider "vellum" outside managed mode, so writing `mode` alone
    // (or keeping "vellum" when switching to your-own) would make the saved
    // config invalid.
    const currentProvider = getConfig().services.stt.provider;
    setNestedValue(
      raw,
      "services.stt.provider",
      currentProvider === "vellum" && validation.coerced === "your-own"
        ? "deepgram"
        : currentProvider,
    );
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  if (setting === "tts_mode") {
    setNestedValue(raw, "services.tts.mode", validation.coerced);
    // TtsServiceSchema forbids provider "vellum" outside managed mode, so
    // switching to your-own must also replace a vellum provider.
    if (
      validation.coerced === "your-own" &&
      getConfig().services.tts.provider === "vellum"
    ) {
      setNestedValue(raw, "services.tts.provider", "elevenlabs");
    }
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  const broadcastNote = meta.userDefaultsKey
    ? " The change has been broadcast to the desktop client."
    : "";
  return {
    content: `${friendlyName} updated to ${JSON.stringify(
      validation.coerced,
    )}.${broadcastNote}`,
    isError: false,
  };
}
