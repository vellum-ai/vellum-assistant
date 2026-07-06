import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantChannelsDetail } from "./assistant-channels-detail";

/**
 * The assistant's entry in the Contacts detail pane: identity header card +
 * boxed "Channels" card. The standalone Channels tab composition lives in
 * `assistant-channels-list.stories.tsx`.
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
