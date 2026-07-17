import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScrollShadow } from "./scroll-shadow";

const meta: Meta<typeof ScrollShadow> = {
  title: "Components/ScrollShadow",
  component: ScrollShadow,
  argTypes: {
    orientation: {
      control: "inline-radio",
      options: ["vertical", "horizontal"],
    },
    size: { control: { type: "number", min: 0, max: 80 } },
    offset: { control: { type: "number", min: 0, max: 40 } },
    hideScrollBar: { control: "boolean" },
    isEnabled: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof ScrollShadow>;

export const Vertical: Story = {
  args: { orientation: "vertical", size: 28, hideScrollBar: true },
  render: (args) => (
    <ScrollShadow
      {...args}
      className="h-[240px] max-w-[420px] rounded-lg bg-[var(--surface-lift)] p-4"
    >
      <div className="flex flex-col gap-3">
        {Array.from({ length: 20 }).map((_, i) => (
          <p
            key={i}
            className="text-body-medium-default text-[var(--content-default)]"
          >
            Row {i + 1} — scroll to watch the top and bottom fades appear and
            disappear as you reach each edge.
          </p>
        ))}
      </div>
    </ScrollShadow>
  ),
};

export const Horizontal: Story = {
  args: { orientation: "horizontal", size: 40, hideScrollBar: true },
  render: (args) => (
    <ScrollShadow
      {...args}
      className="max-w-[420px] rounded-lg bg-[var(--surface-lift)] p-4"
    >
      <div className="flex w-max gap-3">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="shrink-0 rounded-md bg-[var(--surface-sunken)] px-6 py-8 text-[var(--content-default)]"
          >
            Card {i + 1}
          </div>
        ))}
      </div>
    </ScrollShadow>
  ),
};
