import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@vellumai/design-library";
import { Inbox, Send } from "lucide-react";

import { EmptyState } from "@/components/empty-state";

const meta: Meta<typeof EmptyState> = {
  title: "Components/EmptyState",
  component: EmptyState,
  args: {
    icon: <Inbox className="h-6 w-6" />,
    title: "Nothing here yet",
    description: "Items you add will show up in this list.",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {};

/** With a call-to-action, as used by the disconnected channel tabs. */
export const WithAction: Story = {
  args: {
    icon: <Send className="h-6 w-6" />,
    title: "Telegram isn't connected",
    description:
      "Connect a Telegram bot so your assistant can send and receive messages on Telegram.",
    action: <Button variant="outlined">Set up</Button>,
  },
};

/** Text-only, no icon well or action. */
export const TextOnly: Story = {
  args: {
    icon: undefined,
    title: "No results",
    description: "Try a different search term.",
    action: undefined,
  },
};
