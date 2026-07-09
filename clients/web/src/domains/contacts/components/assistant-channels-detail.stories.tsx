import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantChannelsDetail } from "./assistant-channels-detail";

/**
 * The assistant's entry in the Contacts detail pane: identity header card +
 * a boxed "Channels" card with one connect/disconnect row per adapter.
 * Channel management (credential forms, trust floors, Slack settings) lives
 * in the standalone Channels tab — see `assistant-channels-list.stories.tsx`.
 */
const meta: Meta<typeof AssistantChannelsDetail> = {
  title: "Contacts/AssistantChannelsDetail",
  component: AssistantChannelsDetail,
  args: {
    assistantName: "Example Assistant",
    channels: [
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "telegram", status: "not_configured" },
      { key: "phone", status: "not_configured" },
    ],
    onConnect: () => {},
    onDisconnect: () => {},
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

type Story = StoryObj<typeof AssistantChannelsDetail>;

export const ContactsDetailView: Story = {};

/** Every adapter connected, each with its handle and disconnect action. */
export const AllConnected: Story = {
  args: {
    channels: [
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "telegram", status: "ready", address: "@example_assistant_bot" },
      { key: "phone", status: "ready", address: "+1 (555) 555-0142" },
    ],
  },
};
