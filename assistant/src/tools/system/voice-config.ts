import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { normalizeActivationKey } from "../../daemon/handlers/config-voice.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Valid voice config settings and their UserDefaults key mappings.
 */
const VOICE_SETTINGS = {
  activation_key: {
    userDefaultsKey: "pttActivationKey",
    type: "string" as const,
  },
  wake_word_enabled: {
    userDefaultsKey: "wakeWordEnabled",
    type: "boolean" as const,
  },
  wake_word_keyword: {
    userDefaultsKey: "wakeWordKeyword",
    type: "string" as const,
  },
  wake_word_timeout: {
    userDefaultsKey: "wakeWordTimeoutSeconds",
    type: "number" as const,
  },
  tts_voice_id: { userDefaultsKey: "ttsVoiceId", type: "string" as const },
} as const;

type VoiceSettingName = keyof typeof VOICE_SETTINGS;

const VALID_SETTINGS = Object.keys(VOICE_SETTINGS) as VoiceSettingName[];

const VALID_TIMEOUTS = [5, 10, 15, 30, 60];

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
      // Use the canonical normalizer from config-voice handler
      const result = normalizeActivationKey(value);
      if (!result.ok) {
        return { ok: false, error: result.reason };
      }
      return { ok: true, coerced: result.value };
    }
    case "wake_word_enabled": {
      if (typeof value === "boolean") return { ok: true, coerced: value };
      if (value === "true") return { ok: true, coerced: true };
      if (value === "false") return { ok: true, coerced: false };
      return {
        ok: false,
        error: 'wake_word_enabled must be a boolean (or "true"/"false" string)',
      };
    }
    case "wake_word_keyword": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          ok: false,
          error: "wake_word_keyword must be a non-empty string",
        };
      }
      return { ok: true, coerced: value.trim() };
    }
    case "wake_word_timeout": {
      const num = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(num) || !VALID_TIMEOUTS.includes(num)) {
        return {
          ok: false,
          error: `wake_word_timeout must be one of: ${VALID_TIMEOUTS.join(
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

const FRIENDLY_NAMES: Record<VoiceSettingName, string> = {
  activation_key: "PTT activation key",
  wake_word_enabled: "Wake word",
  wake_word_keyword: "Wake word keyword",
  wake_word_timeout: "Wake word timeout",
  tts_voice_id: "ElevenLabs voice",
};

export class VoiceConfigUpdateTool implements Tool {
  name = "voice_config_update";
  description =
    "Update a voice configuration setting (TTS voice ID, PTT activation key, wake word enabled/keyword/timeout). " +
    "Changes take effect immediately.";
  category = "system";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          setting: {
            type: "string",
            enum: [...VALID_SETTINGS],
            description: "The voice setting to change",
          },
          value: {
            description:
              "The new value for the setting (type depends on setting)",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are changing and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
      },
    };
  }

  async execute(
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

    // Send client_settings_update IPC to write to UserDefaults
    if (context.sendToClient) {
      context.sendToClient({
        type: "client_settings_update",
        key: meta.userDefaultsKey,
        value: validation.coerced,
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

    return {
      content: `${friendlyName} updated to ${JSON.stringify(
        validation.coerced,
      )}. The change has been broadcast to the desktop client.`,
      isError: false,
    };
  }
}

export const voiceConfigUpdateTool = new VoiceConfigUpdateTool();
