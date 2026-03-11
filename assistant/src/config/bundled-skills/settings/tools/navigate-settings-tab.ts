import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const SETTINGS_TABS = [
  "General",
  "Channels",
  "Models & Services",
  "Voice",
  "Permissions & Privacy",
  "Contacts",
  "Developer",
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const tab = input.tab as string;
  if (!SETTINGS_TABS.includes(tab as SettingsTab)) {
    return {
      content: `Error: unknown tab "${tab}". Valid tabs: ${SETTINGS_TABS.join(
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
