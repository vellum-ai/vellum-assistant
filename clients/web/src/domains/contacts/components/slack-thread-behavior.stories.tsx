import type { Meta, StoryObj } from "@storybook/react-vite";

import { SlackThreadBehavior } from "./slack-thread-behavior";

const meta: Meta<typeof SlackThreadBehavior> = {
  title: "Contacts/SlackThreadBehavior",
  component: SlackThreadBehavior,
  args: {
    threadMode: "mention_then_thread",
    onThreadModeChange: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 800, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SlackThreadBehavior>;

export const ThreadBehavior: Story = {};

/** A thread-mode write in flight disables the radios. */
export const SavePending: Story = {
  args: {
    threadModePending: true,
  },
};
