import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreHorizontal } from "lucide-react";

import { CrossfadeStack } from "./crossfade-stack";

const meta: Meta<typeof CrossfadeStack> = {
  title: "Components/CrossfadeStack",
  component: CrossfadeStack,
  parameters: {
    docs: {
      description: {
        component:
          "Places two occupants in one cell so they trade places rather than sit side by side. Hover the row to swap the count for the menu.",
      },
    },
  },
  args: {
    children: [
      <span
        key="badge"
        className="rounded-full bg-[var(--surface-active)] px-2 text-body-small-default text-[var(--content-secondary)] transition-opacity group-hover:opacity-0"
      >
        12
      </span>,
      <button
        key="action"
        type="button"
        aria-label="More"
        className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>,
    ],
  },
  decorators: [
    (Story) => (
      <div className="group flex w-[220px] items-center justify-between rounded-[6px] bg-[var(--surface-lift)] p-2 text-[var(--content-default)]">
        <span className="text-body-medium-default">Pinned</span>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof CrossfadeStack>;

export const Default: Story = {};
