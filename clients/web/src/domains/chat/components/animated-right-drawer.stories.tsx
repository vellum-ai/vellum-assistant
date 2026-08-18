import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@vellumai/design-library";

import { AnimatedRightDrawer } from "./animated-right-drawer";

/**
 * The drawer's whole point is the open/close width animation, which a static
 * story cannot show, so every story here drives `open` from a real control the
 * way `ChatContentLayout` does. The resize edge is only mounted while the
 * drawer is open, so opening it is also the only way to review the separator.
 */
const meta: Meta<typeof AnimatedRightDrawer> = {
  title: "Chat/AnimatedRightDrawer",
  component: AnimatedRightDrawer,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Chat beside a tool-detail drawer whose width is the animated " +
          "dimension. Open it, then Tab to the divider: Left/Right nudge it " +
          "(Shift for a coarser step) and Home/End jump to the bounds.",
      },
    },
  },
  args: {
    defaultWidth: 400,
    minWidth: 300,
    minLeftWidth: 300,
  },
  argTypes: {
    open: { control: false },
    left: { control: false },
    right: { control: false },
    storageKey: { control: false },
  },
  decorators: [
    (Story) => (
      <div style={{ height: "520px", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AnimatedRightDrawer>;

function Filler({ label, bg }: { label: string; bg: string }) {
  return (
    <div
      className="flex h-full items-center justify-center px-6 text-center"
      style={{ backgroundColor: bg }}
    >
      <span className="text-sm font-medium text-[color:var(--content-default)]">
        {label}
      </span>
    </div>
  );
}

export const Default: Story = {
  render: function Render(args) {
    const [open, setOpen] = useState(true);
    return (
      <AnimatedRightDrawer
        {...args}
        open={open}
        left={
          <div className="flex h-full flex-col">
            <div className="p-4">
              <Button onClick={() => setOpen((prev) => !prev)}>
                {open ? "Close panel" : "Open panel"}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Filler
                label="Chat, takes the remainder"
                bg="var(--surface-base)"
              />
            </div>
          </div>
        }
        right={
          open ? (
            <Filler label="Tool detail, sized" bg="var(--surface-lift)" />
          ) : null
        }
      />
    );
  },
};

/**
 * Closed on mount, so the open animation plays on the first click rather than
 * the close animation. The separator is absent until the drawer is open.
 */
export const ClosedInitially: Story = {
  ...Default,
  render: function Render(args) {
    const [open, setOpen] = useState(false);
    return (
      <AnimatedRightDrawer
        {...args}
        open={open}
        left={
          <div className="flex h-full flex-col">
            <div className="p-4">
              <Button onClick={() => setOpen((prev) => !prev)}>
                {open ? "Close panel" : "Open panel"}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <Filler label="Chat, full width" bg="var(--surface-base)" />
            </div>
          </div>
        }
        right={
          open ? (
            <Filler label="Tool detail, sized" bg="var(--surface-lift)" />
          ) : null
        }
      />
    );
  },
};
