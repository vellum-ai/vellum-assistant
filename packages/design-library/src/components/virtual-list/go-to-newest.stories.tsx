import type { Meta, StoryObj } from "@storybook/react-vite";

import { GoToNewest } from "./go-to-newest";

const meta: Meta<typeof GoToNewest> = {
  title: "Components/VirtualList/GoToNewest",
  component: GoToNewest,
  argTypes: {
    visible: { control: "boolean" },
    isStreaming: { control: "boolean" },
  },
  args: {
    visible: true,
    isStreaming: false,
    onClick: () => {},
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          padding: 48,
          background: "var(--surface-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof GoToNewest>;

export const Default: Story = {};

/** Animated three-dot pulse signalling content is still arriving out of view.
 *  The pulse is gated behind `motion-safe`, so it pauses under
 *  `prefers-reduced-motion`. */
export const Streaming: Story = {
  args: { isStreaming: true },
};

/** Hidden state — fades to `opacity-0`, stops capturing pointer events, and
 *  leaves the tab order. Toggle `visible` in the controls to see the fade. */
export const Hidden: Story = {
  args: { visible: false },
};
