import type { Meta, StoryObj } from "@storybook/react-vite";

import { ResizablePanel } from "./resizable-panel";

const meta: Meta<typeof ResizablePanel> = {
  title: "Components/ResizablePanel",
  component: ResizablePanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A sized right pane beside a flexible left one. The divider is " +
          "focusable: Tab to it, then Left/Right to nudge (hold Shift for a " +
          "coarser step) and Home/End to jump to the narrowest and widest " +
          "allowed. Implements the APG window splitter pattern: " +
          "https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/",
      },
    },
  },
  args: {
    left: (
      <Pane label="Left pane, takes the remainder" bg="var(--surface-base)" />
    ),
    right: <Pane label="Right pane, sized" bg="var(--surface-lift)" />,
    defaultRightWidth: 320,
    minRightWidth: 200,
    minLeftWidth: 200,
    separatorLabel: "Resize panels",
    hideDivider: false,
  },
  argTypes: {
    left: { control: false },
    right: { control: false },
    onWidthChange: { control: false },
    storageKey: { control: false },
  },
  decorators: [
    (Story) => (
      <div style={{ height: "400px", width: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ResizablePanel>;

function Pane({ label, bg }: { label: string; bg: string }) {
  return (
    <div
      className="flex h-full items-center justify-center px-4 text-center"
      style={{ backgroundColor: bg }}
    >
      <span className="text-sm font-medium text-[color:var(--content-default)]">
        {label}
      </span>
    </div>
  );
}

export const Default: Story = {};

/**
 * Tighter minimums on both sides, so Home and End have somewhere to travel and
 * the clamp is visible when you push the divider to either bound.
 */
export const NarrowMinimums: Story = {
  args: {
    defaultRightWidth: 240,
    minRightWidth: 120,
    minLeftWidth: 120,
  },
};

/**
 * The divider line hidden while the full drag hit-area and grab handle remain,
 * for when the right pane carries its own container chrome. This is how both
 * master-detail pages mount it.
 */
export const HiddenDivider: Story = {
  args: {
    hideDivider: true,
    defaultRightWidth: 400,
  },
};
