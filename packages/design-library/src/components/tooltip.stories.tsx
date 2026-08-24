import { Globe } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { WithoutHover } from "../utils/hover-capability.story-helper";
import { Button } from "./button";
import { Popover } from "./popover";
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

/**
 * On a device that cannot hover, nothing mounts: no trigger wrapper, and no
 * label however the trigger is approached. A tooltip opens on focus as well as
 * on hover, and on a touch surface focus is something a tap hands out, so a
 * label that mounted there would arrive unbidden and stay until something else
 * took focus.
 *
 * The trigger is a plain button underneath, which is why the copy that matters
 * belongs on `aria-label` rather than in the tooltip.
 */
export const WithoutHoverCapability: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <WithoutHover>
      <Tooltip {...args}>
        <Button iconOnly={<Globe className="h-4 w-4" />} aria-label="Deploy" />
      </Tooltip>
    </WithoutHover>
  ),
  play: async () => {
    const trigger = await screen.findByRole("button", { name: "Deploy" });

    // Radix stamps its open state on whatever element it makes a trigger, so
    // the absence of one says nothing was wrapped rather than merely that
    // nothing is showing.
    expect(trigger).not.toHaveAttribute("data-state");

    await userEvent.hover(trigger);
    trigger.focus();

    // Held across the open delay rather than sampled once, since a label that
    // only arrives after it is the one a single check would miss.
    await expect(
      waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument(), {
        timeout: 600,
      }),
    ).rejects.toThrow();
  },
};

/**
 * A tooltip is often the inner half of a composed trigger: an outer primitive
 * takes `asChild`, clones its open-on-click handlers onto the `Tooltip`, and
 * the wrapper passes them down to the element underneath.
 *
 * That forwarding is what makes the control work, so it survives the
 * suppression above. Without it the popover would open everywhere except the
 * devices that have no other way in.
 */
export const ComposedTriggerWithoutHoverCapability: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <WithoutHover>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Tooltip {...args}>
            <Button variant="outlined">Deploy</Button>
          </Tooltip>
        </Popover.Trigger>
        <Popover.Content side="bottom">Pick an environment</Popover.Content>
      </Popover.Root>
    </WithoutHover>
  ),
  play: async () => {
    const trigger = await screen.findByRole("button", { name: "Deploy" });

    await userEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("Pick an environment")).toBeInTheDocument();
    });
  },
};

/**
 * A sentence-length tooltip wraps instead of stretching into one long line.
 *
 * Real copy reaches this length whenever a tooltip explains a problem and
 * its fix, so the content is capped at 20rem and never exceeds the space
 * Radix reports on the chosen side. Forced open so the wrapping is visible
 * in a static screenshot.
 */
export const LongContent: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <TooltipProvider delayDuration={0}>
      <div
        style={{ padding: "6rem", display: "flex", justifyContent: "center" }}
      >
        <Tooltip.Root defaultOpen delayDuration={0}>
          <Tooltip.Trigger asChild>
            <Button variant="outlined">Needs attention</Button>
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">
            Missing a model, so actions using it fall back to another profile.
            Click to fix.
          </Tooltip.Content>
        </Tooltip.Root>
      </div>
    </TooltipProvider>
  ),
};
