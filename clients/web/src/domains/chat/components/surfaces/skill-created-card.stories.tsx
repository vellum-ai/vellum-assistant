import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import type { Surface } from "@/domains/chat/types/types";

import { SkillCreatedCard } from "./skill-created-card";

const SURFACE = {
  surfaceId: "skill-card-conv-xyz",
  surfaceType: "skill_card",
  title: "I just learned how to do Retail Product Stock Check",
  display: "inline",
  data: {
    skills: [
      {
        skillId: "skill-1",
        name: "Retail Product Stock Check",
        description: "Check whether a product is in stock on a retailer's site.",
        emoji: "📦",
      },
    ],
  },
} satisfies Surface;

const meta = {
  title: "Chat/SkillCreatedCard",
  component: SkillCreatedCard,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    surface: SURFACE,
    onAction: fn(),
  },
} satisfies Meta<typeof SkillCreatedCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MultipleSkills: Story = {
  args: {
    surface: {
      ...SURFACE,
      title: "I just learned how to do 2 new things",
      data: {
        skills: [
          ...SURFACE.data.skills,
          {
            skillId: "skill-2",
            name: "Weekly Report Digest",
            description: "Compile the weekly report from the usual sources.",
            emoji: "📊",
          },
        ],
      },
    },
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
