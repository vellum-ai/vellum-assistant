import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SkillToolSummary } from "@/domains/chat/utils/skill-activity";

import { SkillToolList } from "./skill-tool-list";

const meta: Meta<typeof SkillToolList> = {
  title: "Chat/ToolActivity/SkillToolList",
  component: SkillToolList,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] rounded-xl bg-[var(--surface-lift)] p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SkillToolList>;

const appBuilderTools: SkillToolSummary[] = [
  {
    name: "app_create",
    description: "Create a new app in the user's Library and return its folder path.",
    fromSkill: null,
    params: [
      {
        name: "name",
        type: "string",
        required: true,
        description: "Display name shown in the Library.",
      },
      {
        name: "template",
        type: "string",
        required: false,
        description: "Starter template id.",
      },
    ],
  },
  {
    name: "app_refresh",
    description: "Rebuild an existing app and refresh any open preview.",
    fromSkill: null,
    params: [
      {
        name: "app_id",
        type: "string",
        required: true,
        description: "Id returned by app_create.",
      },
    ],
  },
];

/** The common case: one skill's own tools, each with typed parameters. */
export const Default: Story = {
  args: { tools: appBuilderTools },
};

/** A tool the daemon printed with no parameter list. */
export const WithoutParameters: Story = {
  args: {
    tools: [
      {
        name: "app_list",
        description: "List every app in the user's Library.",
        fromSkill: null,
        params: [],
      },
    ],
  },
};

/**
 * A composite skill: tools contributed by a nested child skill are grouped
 * under that skill's name so their provenance stays visible.
 */
export const WithChildSkill: Story = {
  args: {
    tools: [
      ...appBuilderTools,
      {
        name: "chart_render",
        description: "Render a chart widget into the current app.",
        fromSkill: "charting",
        params: [
          {
            name: "series",
            type: "array",
            required: true,
            description: "Data points to plot.",
          },
        ],
      },
      {
        name: "chart_theme",
        description: "Apply a design-token theme to every chart in the app.",
        fromSkill: "charting",
        params: [],
      },
    ],
  },
};
