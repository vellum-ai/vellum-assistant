import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  matchModel,
  MODEL_DISPLAY_NAMES,
  PROVIDER_MODEL_SHORTCUTS,
} from "../../daemon/session-slash.js";
import { RiskLevel } from "../../permissions/types.js";
import { initializeProviders } from "../../providers/registry.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Settings that can be changed via the update_setting tool.
 *
 * Each entry maps a setting name to:
 * - configKey: the dot-path in the assistant config file
 * - userDefaultsKey: (optional) the macOS UserDefaults key to broadcast via IPC
 * - type: expected value type
 * - friendlyName: human-readable name for confirmation messages
 */
const SETTINGS = {
  model: {
    configKey: "model",
    type: "string" as const,
    friendlyName: "Model",
  },
  media_embeds_enabled: {
    configKey: "ui.mediaEmbeds.enabled",
    userDefaultsKey: "mediaEmbedsEnabled",
    type: "boolean" as const,
    friendlyName: "Media embeds",
  },
  cmd_enter_to_send: {
    configKey: null, // client-only setting
    userDefaultsKey: "cmdEnterToSend",
    type: "boolean" as const,
    friendlyName: "Send with Cmd+Enter",
  },
  max_steps: {
    configKey: "maxSteps",
    type: "number" as const,
    friendlyName: "Max steps",
  },
} as const;

type SettingName = keyof typeof SETTINGS;
const VALID_SETTINGS = Object.keys(SETTINGS) as SettingName[];

export class UpdateSettingTool implements Tool {
  name = "update_setting";
  description =
    "Update an assistant setting (model, media embeds, send shortcut, max steps). " +
    "Use this when the user asks to change a setting through conversation instead of the settings panel. " +
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
            description:
              "The setting to change. " +
              'model — switch the LLM model (e.g. "claude-sonnet-4-6", "opus", "haiku"). ' +
              "media_embeds_enabled — enable/disable media embeds in chat. " +
              "cmd_enter_to_send — toggle between Enter and Cmd+Enter to send messages. " +
              "max_steps — max computer-use steps per session (number).",
          },
          value: {
            description:
              "The new value. Type depends on setting: string for model, boolean for toggles, number for max_steps.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are changing and why.",
          },
        },
        required: ["setting", "value"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const setting = input.setting as string | undefined;
    const value = input.value;

    if (!setting || !VALID_SETTINGS.includes(setting as SettingName)) {
      return {
        content: `Error: unknown setting "${setting}". Valid settings: ${VALID_SETTINGS.join(", ")}`,
        isError: true,
      };
    }

    if (value === undefined) {
      return {
        content: `Error: "value" is required for setting "${setting}".`,
        isError: true,
      };
    }

    const meta = SETTINGS[setting as SettingName];

    // Special handling for model switching
    if (setting === "model") {
      return this.handleModelSwitch(String(value), context);
    }

    // Validate and coerce the value
    const coerced = this.coerceValue(value, meta.type);
    if (coerced.error) {
      return { content: `Error: ${coerced.error}`, isError: true };
    }

    // Update config file if there's a config key
    if (meta.configKey) {
      const raw = loadRawConfig();
      setNestedValue(raw, meta.configKey, coerced.value);
      saveRawConfig(raw);
    }

    // Broadcast to macOS client via IPC if there's a UserDefaults key
    if ("userDefaultsKey" in meta && meta.userDefaultsKey && context.sendToClient) {
      context.sendToClient({
        type: "client_settings_update",
        key: meta.userDefaultsKey,
        value: coerced.value,
      });
    }

    return {
      content: `${meta.friendlyName} updated to ${JSON.stringify(coerced.value)}.`,
      isError: false,
    };
  }

  private handleModelSwitch(
    value: string,
    _context: ToolContext,
  ): ToolExecutionResult {
    const matched = matchModel(value);
    if (!matched) {
      const available = Object.entries(MODEL_DISPLAY_NAMES)
        .map(([id, name]) => `- **${name}** (\`${id}\`)`)
        .join("\n");
      return {
        content: `Unknown model "${value}". Available models:\n${available}`,
        isError: true,
      };
    }

    const currentConfig = getConfig();
    const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;

    if (currentConfig.model === matched) {
      return {
        content: `Already using **${displayName}**.`,
        isError: false,
      };
    }

    // Resolve provider from shortcuts or default to anthropic
    const shortcut = Object.values(PROVIDER_MODEL_SHORTCUTS).find(
      (s) => s.model === matched,
    );
    const provider = shortcut?.provider ?? "anthropic";

    const raw = loadRawConfig();
    raw.provider = provider;
    raw.model = matched;
    saveRawConfig(raw);

    const config = getConfig();
    initializeProviders(config);

    return {
      content: `Switched to **${displayName}**. New conversations will use this model.`,
      isError: false,
    };
  }

  private coerceValue(
    value: unknown,
    type: "string" | "boolean" | "number",
  ): { value: string | boolean | number; error?: undefined } | { value?: undefined; error: string } {
    switch (type) {
      case "boolean": {
        if (typeof value === "boolean") return { value };
        if (value === "true") return { value: true };
        if (value === "false") return { value: false };
        return { error: `Expected boolean, got "${value}"` };
      }
      case "number": {
        const n = typeof value === "number" ? value : Number(value);
        if (isNaN(n)) return { error: `Expected number, got "${value}"` };
        return { value: n };
      }
      case "string":
        return { value: String(value) };
    }
  }
}

export const updateSettingTool = new UpdateSettingTool();
