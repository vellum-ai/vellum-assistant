import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { Popover } from "./popover.js";

const meta: Meta = {
  title: "Components/Popover",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button>Open Popover</Button>
      </Popover.Trigger>
      <Popover.Content>
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
  render: () => (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outlined">Settings</Button>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start" className="w-64">
        <div className="flex flex-col gap-3 p-2">
          <p className="text-body-medium-default">Settings</p>
          <p className="text-body-medium-lighter text-[color:var(--content-secondary)]">
            Configure your preferences.
          </p>
          <div className="flex justify-end">
            <Popover.Close asChild>
              <Button variant="ghost" size="compact">Close</Button>
            </Popover.Close>
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  ),
};

export const Sides: Story = {
  render: () => (
    <div className="flex gap-4">
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Popover.Root key={side}>
          <Popover.Trigger asChild>
            <Button variant="outlined" size="compact">{side}</Button>
          </Popover.Trigger>
          <Popover.Content side={side}>
            <p className="p-2 text-body-small-default">
              Popover on {side}
            </p>
          </Popover.Content>
        </Popover.Root>
      ))}
    </div>
  ),
};
