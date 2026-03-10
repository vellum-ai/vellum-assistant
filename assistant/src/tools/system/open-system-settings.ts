import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const PANES = {
  microphone: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    label: "Microphone privacy",
    instruction: "Please toggle Vellum Assistant on.",
  },
  speech_recognition: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
    label: "Speech Recognition privacy",
    instruction: "Please toggle Vellum Assistant on.",
  },
} as const;

type PaneName = keyof typeof PANES;

const VALID_PANES = Object.keys(PANES) as PaneName[];

export class OpenSystemSettingsTool implements Tool {
  name = "open_system_settings";
  description =
    "Open a specific macOS System Settings pane (e.g. Microphone or Speech Recognition privacy). " +
    "Use this to guide the user through granting permissions that can only be toggled in System Settings.";
  category = "system";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          pane: {
            type: "string",
            enum: [...VALID_PANES],
            description: "The System Settings pane to open",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are opening and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["pane"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const pane = input.pane as string;
    if (!VALID_PANES.includes(pane as PaneName)) {
      return {
        content: `Error: unknown pane "${pane}". Valid panes: ${VALID_PANES.join(
          ", ",
        )}`,
        isError: true,
      };
    }

    const meta = PANES[pane as PaneName];

    // Send open_url to the client — the x-apple.systempreferences: scheme
    // opens System Settings directly without a browser confirmation dialog.
    if (context.sendToClient) {
      context.sendToClient({
        type: "open_url",
        url: meta.url,
      });
    }

    return {
      content: `Opened System Settings to ${meta.label}. ${meta.instruction}`,
      isError: false,
    };
  }
}

export const openSystemSettingsTool = new OpenSystemSettingsTool();
