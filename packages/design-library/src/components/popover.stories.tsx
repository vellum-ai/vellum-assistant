import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Popover } from "./popover";

interface PopoverStoryArgs {
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
  sideOffset: number;
  alignOffset: number;
  triggerLabel: string;
}

const meta: Meta<PopoverStoryArgs> = {
  title: "Components/Popover",
  parameters: {
    layout: "centered",
  },
  argTypes: {
    side: {
      control: "select",
      options: ["top", "right", "bottom", "left"],
    },
    align: {
      control: "select",
      options: ["start", "center", "end"],
    },
    sideOffset: { control: "number" },
    alignOffset: { control: "number" },
    triggerLabel: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<PopoverStoryArgs>;

export const Default: Story = {
  args: {
    side: "bottom",
    align: "center",
    sideOffset: 6,
    alignOffset: 0,
    triggerLabel: "Open Popover",
  },
  render: ({ side, align, sideOffset, alignOffset, triggerLabel }) => (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button>{triggerLabel}</Button>
      </Popover.Trigger>
      <Popover.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
      >
        <div className="flex flex-col gap-2 p-2">
          <p className="text-body-medium-default">Popover content</p>
          <p className="text-body-medium-lighter text-[color:var(--content-secondary)]">
            This is a popover with default styling.
          </p>
        </div>
      </Popover.Content>
    </Popover.Root>
  ),
};

export const WithCloseButton: Story = {
  args: {
    side: "bottom",
    align: "start",
    sideOffset: 6,
    alignOffset: 0,
    triggerLabel: "Settings",
  },
  render: ({ side, align, sideOffset, alignOffset, triggerLabel }) => (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outlined">{triggerLabel}</Button>
      </Popover.Trigger>
      <Popover.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="w-64"
      >
        <div className="flex flex-col gap-3 p-2">
          <p className="text-body-medium-default">Settings</p>
          <p className="text-body-medium-lighter text-[color:var(--content-secondary)]">
            Configure your preferences.
          </p>
          <div className="flex justify-end">
            <Popover.Close asChild>
              <Button variant="ghost" size="compact">
                Close
              </Button>
            </Popover.Close>
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  ),
};

export const Sides: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Renders one popover per side to show all placements at once.",
      },
    },
  },
  render: () => (
    <div className="flex gap-4">
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Popover.Root key={side}>
          <Popover.Trigger asChild>
            <Button variant="outlined" size="compact">
              {side}
            </Button>
          </Popover.Trigger>
          <Popover.Content side={side}>
            <p className="p-2 text-body-small-default">Popover on {side}</p>
          </Popover.Content>
        </Popover.Root>
      ))}
    </div>
  ),
};
