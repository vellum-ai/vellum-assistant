import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isWindows } from "../../../../util/platform.js";

const PANES = {
  microphone: {
    label: "Microphone privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      windows: "ms-settings:privacy-microphone",
    },
  },
  speech_recognition: {
    label: "Speech Recognition privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
      windows: "ms-settings:privacy-speech",
    },
  },
} as const;

type PaneName = keyof typeof PANES;
type SettingsPlatform = keyof (typeof PANES)[PaneName]["urls"];

const VALID_PLATFORMS: SettingsPlatform[] = ["macos", "windows"];
const VALID_PANES = Object.keys(PANES) as PaneName[];

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const requestedPlatform = input.platform as string | undefined;
  if (
    requestedPlatform !== undefined &&
    !VALID_PLATFORMS.includes(requestedPlatform as SettingsPlatform)
  ) {
    return {
      content: `Error: unknown platform "${requestedPlatform}". Valid platforms: ${VALID_PLATFORMS.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  const pane = input.pane as string;
  if (!VALID_PANES.includes(pane as PaneName)) {
    return {
      content: `Error: unknown pane "${pane}". Valid panes: ${VALID_PANES.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  const platform =
    (requestedPlatform as SettingsPlatform | undefined) ??
    (isWindows() ? "windows" : "macos");
  const meta = PANES[pane as PaneName];

  if (context.sendToClient) {
    context.sendToClient({
      type: "open_url",
      url: meta.urls[platform],
      conversationId: context.conversationId,
    });
  }

  const settingsName =
    platform === "windows" ? "Windows Settings" : "System Settings";
  return {
    content: `Opened ${settingsName} to ${meta.label}. Please enable Vellum Assistant.`,
    isError: false,
  };
}
