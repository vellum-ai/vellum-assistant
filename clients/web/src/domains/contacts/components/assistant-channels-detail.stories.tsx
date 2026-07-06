import type { Meta, StoryObj } from "@storybook/react-vite";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import { AssistantChannelsDetail } from "./assistant-channels-detail";

/**
 * The assistant's entry in the Contacts detail pane: identity header card +
 * boxed "Channels" card. The standalone Channels tab composition lives in
 * `assistant-channels-list.stories.tsx`. The card renders the shared
 * `AssistantChannelsList`, whose layout is gated on `channel-trust-floors`
 * (sub-tabs on, accordion off).
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
    onSetup: () => {},
    onDisconnect: () => {},
    onSaveTelegramToken: async () => {},
    onSaveSlackConfig: () => {},
    onSaveTwilioCredentials: async () => {},
  },
  decorators: [
    (Story) => {
      useAssistantFeatureFlagStore.setState({
        channelTrustFloors: true,
        hasHydrated: true,
      });
      return (
        <div style={{ maxWidth: 800, margin: "2rem auto" }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;

type Story = StoryObj<typeof AssistantChannelsDetail>;

export const ContactsDetailView: Story = {};

/** The accordion layout rendered while `channel-trust-floors` is off. */
export const ContactsDetailViewLegacy: Story = {
  decorators: [
    (Story) => {
      useAssistantFeatureFlagStore.setState({
        channelTrustFloors: false,
        hasHydrated: true,
      });
      return <Story />;
    },
  ],
};
