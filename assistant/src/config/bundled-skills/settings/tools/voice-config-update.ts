import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../../config/loader.js";
import { normalizeActivationKey } from "../../../../daemon/handlers/config-voice.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * Valid voice config settings and their UserDefaults key mappings.
 */
const VOICE_SETTINGS = {
  activation_key: {
    userDefaultsKey: "pttActivationKey",
    type: "string" as const,
  },
  conversation_timeout: {
    userDefaultsKey: "voiceConversationTimeoutSeconds",
    type: "number" as const,
  },
  tts_voice_id: { userDefaultsKey: "ttsVoiceId", type: "string" as const },
} as const;

type VoiceSettingName = keyof typeof VOICE_SETTINGS;

const VALID_SETTINGS = Object.keys(VOICE_SETTINGS) as VoiceSettingName[];

const VALID_TIMEOUTS = [5, 10, 15, 30, 60];

const FRIENDLY_NAMES: Record<VoiceSettingName, string> = {
  activation_key: "PTT activation key",
  conversation_timeout: "Conversation timeout",
  tts_voice_id: "ElevenLabs voice",
};

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

  const meta = VOICE_SETTINGS[setting as VoiceSettingName];
  const friendlyName = FRIENDLY_NAMES[setting as VoiceSettingName];

  // Send client_settings_update message to write to UserDefaults.
  // Always stringify the value — Swift's ClientSettingsUpdate.value is typed
  // as String, so a bare JSON number would fail to decode.
  if (context.sendToClient) {
    context.sendToClient({
      type: "client_settings_update",
      key: meta.userDefaultsKey,
      value: String(validation.coerced),
    });
  }

  // For tts_voice_id, also persist to the config file (elevenlabs.voiceId)
  // so phone calls and other consumers pick it up.
  if (setting === "tts_voice_id") {
    const raw = loadRawConfig();
    setNestedValue(raw, "elevenlabs.voiceId", validation.coerced);
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  // For conversation_timeout, persist to the config file
  // (elevenlabs.conversationTimeoutSeconds).
  if (setting === "conversation_timeout") {
    const raw = loadRawConfig();
    setNestedValue(
      raw,
      "elevenlabs.conversationTimeoutSeconds",
      validation.coerced,
    );
    saveRawConfig(raw);
    invalidateConfigCache();
  }

  return {
    content: `${friendlyName} updated to ${JSON.stringify(
      validation.coerced,
    )}. The change has been broadcast to the desktop client.`,
    isError: false,
  };
}
