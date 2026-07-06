import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantChannelsDetail } from "./assistant-channels-detail";

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
    onSetup: () => {},
    onDisconnect: () => {},
    onSaveTelegramToken: async () => {},
    onSaveSlackConfig: () => {},
    onSaveTwilioCredentials: async () => {},
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

/** As rendered inside the Contacts page's assistant detail view. */
export const ContactsDetailView: Story = {};

/** As rendered on the standalone Channels tab — no identity header card. */
export const ChannelsTab: Story = {
  args: {
    showIdentityCard: false,
  },
};

/** Slack expanded with the trust-floor control, as after a `?setup=slack` deep link. */
export const ChannelsTabSlackExpanded: Story = {
  args: {
    showIdentityCard: false,
    initialExpandedChannel: "slack",
    slackThreadMode: "mention_then_thread",
    onSlackThreadModeChange: () => {},
    channelPolicies: { slack: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};
