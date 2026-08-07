import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { voicePickerHint } from "./shared.js";

const SETTINGS_TABS = [
  "General",
  "Models & Services",
  "Voice",
  "Services",
  "Sounds",
  "Permissions & Privacy",
  "Billing",
  "Archive",
  "Schedules",
  "Debug",
  "Developer",
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

const LEGACY_TAB_ALIASES: Record<string, SettingsTab> = {
  "Archived Conversations": "Archive",
};

const VOICE_TAB_PICKER_HINT = voicePickerHint(
  "which puts the picker in the conversation without navigating away. Navigating here is right only when the user explicitly asked to open Settings.",
);

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const rawTab = input.tab as string;
  const tab = LEGACY_TAB_ALIASES[rawTab] ?? rawTab;
  if (!SETTINGS_TABS.includes(tab as SettingsTab)) {
    return {
      content: `Error: unknown tab "${rawTab}". Valid tabs: ${SETTINGS_TABS.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  if (context.sendToClient) {
    context.sendToClient({
      type: "navigate_settings",
      tab,
    });
  }

  const opened = `Opened settings to the ${tab} tab.`;
  return {
    content: tab === "Voice" ? `${opened} ${VOICE_TAB_PICKER_HINT}` : opened,
    isError: false,
  };
}
