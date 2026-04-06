import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const SETTINGS_TABS = [
  "General",
  "Models & Services",
  "Voice",
  "Sounds",
  "Permissions & Privacy",
  "Billing",
  "Archive",
  "Schedules",
  "Developer",
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

const LEGACY_TAB_ALIASES: Record<string, SettingsTab> = {
  "Archived Conversations": "Archive",
};

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

  return {
    content: `Opened settings to the ${tab} tab.`,
    isError: false,
  };
}
