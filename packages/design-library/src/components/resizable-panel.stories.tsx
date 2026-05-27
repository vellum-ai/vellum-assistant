import type { Meta, StoryObj } from "@storybook/react-vite";

import { ResizablePanel } from "./resizable-panel";

const meta: Meta<typeof ResizablePanel> = {
  title: "Components/ResizablePanel",
  component: ResizablePanel,
  parameters: {
    layout: "fullscreen",
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
      className="flex h-full items-center justify-center"
      style={{ backgroundColor: bg }}
    >
      <span className="text-sm font-medium text-[color:var(--content-default)]">
        {label}
      </span>
    </div>
  );
}

export const Default: Story = {
  args: {
    left: <Pane label="Left pane" bg="var(--surface-base)" />,
    right: <Pane label="Right pane" bg="var(--surface-lift)" />,
    defaultLeftWidth: 300,
  },
};

export const CustomMinWidths: Story = {
  args: {
    left: <Pane label="Min 200px" bg="var(--surface-base)" />,
    right: <Pane label="Min 150px" bg="var(--surface-lift)" />,
    defaultLeftWidth: 400,
    minLeftWidth: 200,
    minRightWidth: 150,
  },
};

export const NarrowDefault: Story = {
  args: {
    left: <Pane label="Narrow left" bg="var(--surface-base)" />,
    right: <Pane label="Wide right" bg="var(--surface-lift)" />,
    defaultLeftWidth: 200,
    minLeftWidth: 150,
    minRightWidth: 200,
  },
};
