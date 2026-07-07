import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DetailCard } from "@/components/detail-card";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import { AssistantChannelsList } from "./assistant-channels-list";

/**
 * The standalone Channels tab composition (`ChannelsPage` minus its data
 * wiring): a borderless page subtitle, then the channel sub-tabs in a card —
 * matching the sibling About Assistant tabs rather than the boxed
 * "Channels" card used inside the Contacts detail view.
 *
 * The layout is gated on the `channel-trust-floors` flag: sub-tabs when on,
 * the accordion rows when off (see the Legacy story).
 */
const withLayoutFlag = (tabbed: boolean): Decorator => {
  return (Story) => {
    useAssistantFeatureFlagStore.setState({
      channelTrustFloors: tabbed,
      hasHydrated: true,
    });
    return <Story />;
  };
};

// The Slack panel owns its own queries (`SlackChannelSection`), so stories
// need a QueryClient. Requests fail in Storybook (no daemon), so the Slack
// tab's channel list renders its error state; the list's full visuals live
// in the SlackChannelList stories, which mock data via props.
const withQueryClient: Decorator = (Story) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <Story />
  </QueryClientProvider>
);

const meta: Meta<typeof AssistantChannelsList> = {
  title: "Contacts/AssistantChannelsList",
  component: AssistantChannelsList,
  args: {
    assistantId: "assistant-1",
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
    withQueryClient,
    withLayoutFlag(true),
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

/** Connected Slack tab with the trust-floor control, as after a `?setup=slack` deep link. */
export const ChannelsTabSlackConnected: Story = {
  args: {
    initialChannel: "slack",
    slackThreadMode: "mention_then_thread",
    onSlackThreadModeChange: () => {},
    channelPolicies: { slack: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};

/**
 * Disconnected Telegram tab: empty state with guided setup + manual escape
 * hatch. Telegram is listed first so it's the default tab — `initialChannel`
 * is reserved for setup deep links, which skip straight to the manual form.
 */
export const ChannelsTabTelegramDisconnected: Story = {
  args: {
    channels: [
      { key: "telegram", status: "not_configured" },
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "phone", status: "not_configured" },
    ],
  },
};

/** Disconnected Phone tab: empty state with guided setup + manual escape hatch. */
export const ChannelsTabPhoneDisconnected: Story = {
  args: {
    channels: [
      { key: "phone", status: "not_configured" },
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "telegram", status: "not_configured" },
    ],
  },
};

/** A `?setup=telegram` deep link (mobile chat handoff) lands on the manual form. */
export const ChannelsTabTelegramSetupHandoff: Story = {
  args: {
    initialChannel: "telegram",
  },
};

/** The accordion layout rendered while `channel-trust-floors` is off. */
export const LegacyAccordion: Story = {
  decorators: [withLayoutFlag(false)],
};
