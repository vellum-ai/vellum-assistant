import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailCard } from "@/components/detail-card";

import { AssistantChannelsList } from "./assistant-channels-list";

/**
 * The standalone Channels tab composition (`ChannelsPage` minus its data
 * wiring): a borderless page heading, then the channel accordion in a card —
 * matching the sibling About Assistant tabs rather than the boxed
 * "Channels" card used inside the Contacts detail view.
 */
const meta: Meta<typeof AssistantChannelsList> = {
  title: "Contacts/AssistantChannelsList",
  component: AssistantChannelsList,
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
      <div
        style={{
          maxWidth: 960,
          margin: "2rem auto",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <DetailCard
          showBorder={false}
          title="Channels"
          subtitle="Manage where Example Assistant can be reached."
        />
        <DetailCard>
          <Story />
        </DetailCard>
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof AssistantChannelsList>;

export const ChannelsTab: Story = {};

/** Slack expanded with the trust-floor control, as after a `?setup=slack` deep link. */
export const ChannelsTabSlackExpanded: Story = {
  args: {
    initialExpandedChannel: "slack",
    slackThreadMode: "mention_then_thread",
    onSlackThreadModeChange: () => {},
    channelPolicies: { slack: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};
