import { Globe } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Tooltip, TooltipProvider } from "./tooltip";

const meta: Meta<typeof Tooltip> = {
  title: "Components/Tooltip",
  component: Tooltip,
  args: {
    content: "Deploy to production",
    side: "top",
  },
  argTypes: {
    side: {
      control: "inline-radio",
      options: ["top", "right", "bottom", "left"],
    },
    content: { control: "text" },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "3rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Tooltip>;

/**
 * Arg-driven: edit the label and change `side` from the Controls panel, then
 * hover or focus the trigger to reveal the tooltip. The trigger is fixed
 * (the tooltip wraps whatever it's given), so a render function supplies it
 * while spreading the configurable args onto `Tooltip`.
 */
export const Default: Story = {
  render: (args) => (
    <Tooltip {...args}>
      <Button iconOnly={<Globe className="h-4 w-4" />} aria-label="Deploy" />
    </Tooltip>
  ),
};

/**
 * Every side forced open so placement is visible without hovering — a static
 * screenshot can't hover. Uses the compound API with `defaultOpen`.
 */
export const Sides: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <TooltipProvider delayDuration={0}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "4rem",
          padding: "4rem",
          placeItems: "center",
        }}
      >
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Tooltip.Root key={side} defaultOpen delayDuration={0}>
            <Tooltip.Trigger asChild>
              <Button variant="outlined">{side}</Button>
            </Tooltip.Trigger>
            <Tooltip.Content side={side}>Tooltip on {side}</Tooltip.Content>
          </Tooltip.Root>
        ))}
      </div>
    </TooltipProvider>
  ),
};

/** Tooltips also open on keyboard focus, on any focusable trigger. */
export const OnTextTrigger: Story = {
  args: { content: "The unique key used across environments" },
  render: (args) => (
    <Tooltip {...args}>
      <span
        tabIndex={0}
        className="cursor-help text-body-medium-default text-[var(--content-default)] underline decoration-dotted underline-offset-2"
      >
        workspace slug
      </span>
    </Tooltip>
  ),
};
