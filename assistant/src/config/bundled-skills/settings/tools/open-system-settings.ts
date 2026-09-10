import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isLinux, isWindows } from "../../../../util/platform.js";

// Linux desktops expose no URL scheme for these panes, so the assistant offers
// a desktop-specific command instead of an open_url push. Speech recognition
// has no Linux equivalent on either desktop, hence the empty command.
const PANES = {
  microphone: {
    label: "Microphone privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      windows: "ms-settings:privacy-microphone",
    },
    linuxCommand:
      "gnome-control-center sound (GNOME) or systemsettings kcm_pulseaudio (KDE)",
  },
  speech_recognition: {
    label: "Speech Recognition privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
      windows: "ms-settings:privacy-speech",
    },
    linuxCommand: "",
  },
} as const;

type PaneName = keyof typeof PANES;
type SettingsPlatform = keyof (typeof PANES)[PaneName]["urls"] | "linux";

const VALID_PLATFORMS: SettingsPlatform[] = ["macos", "windows", "linux"];
const VALID_PANES = Object.keys(PANES) as PaneName[];

function hostPlatform(): SettingsPlatform {
  if (isLinux()) {
    return "linux";
  }
  return isWindows() ? "windows" : "macos";
}

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
    (requestedPlatform as SettingsPlatform | undefined) ?? hostPlatform();
  const meta = PANES[pane as PaneName];

  if (platform === "linux") {
    return {
      content: meta.linuxCommand
        ? `No settings pane was opened. Linux has no settings URL for ${meta.label}. Offer to run the settings command for the user's desktop: ${meta.linuxCommand}.`
        : `Linux has no ${meta.label} settings pane to open. Tell the user this is not gated by the desktop on Linux.`,
      isError: false,
    };
  }

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
