import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect } from "react";

import { DetailCard } from "@/components/detail-card";
import { useChannelAdapterSelectionStore } from "@/domains/channels/adapter-selection-store";
import type { SetupChannelId } from "@/types/channel-types";

import { AssistantChannelsList } from "./assistant-channels-list";

/**
 * The standalone Channels tab composition (`ChannelsPage` minus its data
 * wiring): a borderless page subtitle over the adapter master-detail — a left
 * rail of adapters beside the selected adapter's detail panel, matching the
 * sibling Contacts tab's Entries + detail shape.
 */
// The Slack panel owns its own queries (`SlackChannelSection`), so stories
// need a QueryClient. Requests fail in Storybook (no daemon), so the Slack
// panel's channel list renders its error state; the list's full visuals live
// in the SlackChannelList stories, which mock data via props.
const withQueryClient: Decorator = (Story) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <Story />
  </QueryClientProvider>
);

/**
 * Pin the master-detail selection for a story. The active adapter lives in a
 * module-level store that persists across story navigation, so each story
 * seeds it explicitly rather than inheriting the previously-viewed adapter.
 */
function withSelectedAdapter(adapter: SetupChannelId): Decorator {
  return function SelectAdapter(Story) {
    useLayoutEffect(() => {
      useChannelAdapterSelectionStore.setState({ selectedAdapter: adapter });
    }, []);
    return <Story />;
  };
}

const meta: Meta<typeof AssistantChannelsList> = {
  title: "Channels/AssistantChannelsList",
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
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof AssistantChannelsList>;

/** Default: Slack selected, its consolidated connection card in the detail panel. */
export const ChannelsTab: Story = {
  decorators: [withSelectedAdapter("slack")],
};

/**
 * Connected Slack: the consolidated connection card (logo, @handle, Connected
 * chip, low-weight Disconnect) with Thread Behavior in the body, over the
 * channel presence list. Slack shows no trust-floor dropdown even with a
 * policy handler wired — its floors are managed per conversation type.
 */
export const ChannelsTabSlackConnected: Story = {
  decorators: [withSelectedAdapter("slack")],
  args: {
    slackThreadMode: "mention_then_thread",
    onSlackThreadModeChange: () => {},
    channelPolicies: { slack: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};

/** Disconnected Slack: the setup wizard in the "Slack setup" card. */
export const ChannelsTabSlackDisconnected: Story = {
  decorators: [withSelectedAdapter("slack")],
  args: {
    channels: [
      { key: "slack", status: "not_configured" },
      { key: "telegram", status: "not_configured" },
      { key: "phone", status: "not_configured" },
    ],
  },
};

/** Disconnected Telegram: empty state with guided setup + manual escape hatch. */
export const ChannelsTabTelegramDisconnected: Story = {
  decorators: [withSelectedAdapter("telegram")],
};

/** Disconnected Phone: empty state with guided setup + manual escape hatch. */
export const ChannelsTabPhoneDisconnected: Story = {
  decorators: [withSelectedAdapter("phone")],
};

/**
 * A `?setup=telegram` deep link (mobile chat handoff) selects Telegram and
 * lands on its manual credential form rather than the empty state.
 */
export const ChannelsTabTelegramSetupHandoff: Story = {
  args: {
    initialChannel: "telegram",
  },
};
