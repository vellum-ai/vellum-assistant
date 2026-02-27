import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const SETTINGS_TABS = [
  'Voice',
  'Connect',
  'Trust',
  'Model',
  'Scheduling',
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

export class NavigateSettingsTabTool implements Tool {
  name = 'navigate_settings_tab';
  description =
    'Open the Vellum settings panel to a specific tab (e.g. Voice, Connect, Trust). ' +
    'Use this when the user needs to review or adjust settings visually.';
  category = 'system';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          tab: {
            type: 'string',
            enum: [...SETTINGS_TABS],
            description: 'The settings tab to navigate to',
          },
        },
        required: ['tab'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const tab = input.tab as string;
    if (!SETTINGS_TABS.includes(tab as SettingsTab)) {
      return {
        content: `Error: unknown tab "${tab}". Valid tabs: ${SETTINGS_TABS.join(', ')}`,
        isError: true,
      };
    }

    if (context.sendToClient) {
      context.sendToClient({
        type: 'navigate_settings',
        tab,
      });
    }

    return {
      content: `Opened settings to the ${tab} tab.`,
      isError: false,
    };
  }
}

export const navigateSettingsTabTool = new NavigateSettingsTabTool();
