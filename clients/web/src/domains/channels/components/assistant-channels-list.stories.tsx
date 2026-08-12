import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SetupChannelId } from "@/types/channel-types";

import { AssistantChannelsList } from "./assistant-channels-list";

/**
 * The standalone Channels tab composition (`ChannelsPage` minus its data
 * wiring): the adapter master-detail — a left rail of adapters beside the
 * selected adapter's detail panel, matching the sibling Contacts tab's
 * Entries + detail shape.
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
 * The app's two Channels routes: the bare tab, and an adapter named in the URL.
 * Selection lives in the URL, so a story needs both patterns for the rail to
 * move the selection the way it does in the app.
 */
const CHANNELS_ROUTES = [
  "/assistant/channels",
  "/assistant/channels/:channelId",
];

/**
 * Pin the master-detail selection for a story: it starts at the selected
 * adapter's address rather than seeding state.
 */
function selectedAdapter(adapter: SetupChannelId) {
  return {
    router: {
      initialEntries: [`/assistant/channels/${adapter}`],
      paths: CHANNELS_ROUTES,
    },
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
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof AssistantChannelsList>;

/** Default: Slack selected, its consolidated connection card in the detail panel. */
export const ChannelsTab: Story = {
  parameters: selectedAdapter("slack"),
};

/**
 * Connected Slack: the consolidated connection card (logo, @handle, Connected
 * chip, low-weight Disconnect) with Thread Behavior in the body, over the
 * channel presence list. Slack shows no trust-floor dropdown even with a
 * policy handler wired — its floors are managed per conversation type.
 */
export const ChannelsTabSlackConnected: Story = {
  parameters: selectedAdapter("slack"),
  args: {
    slackThreadMode: "mention_then_thread",
    onSlackThreadModeChange: () => {},
    channelPolicies: { slack: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};

/** Disconnected Slack: the setup wizard in the "Slack setup" card. */
export const ChannelsTabSlackDisconnected: Story = {
  parameters: selectedAdapter("slack"),
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
  parameters: selectedAdapter("telegram"),
};

/** Disconnected Phone: empty state with guided setup + manual escape hatch. */
export const ChannelsTabPhoneDisconnected: Story = {
  parameters: selectedAdapter("phone"),
};

/**
 * Connected Telegram: the connection header (Connected chip, @handle,
 * Disconnect) and the trust-floor control — and no credential form. Parity
 * with Slack's connected card: the token field belongs to the connect flow.
 */
export const ChannelsTabTelegramConnected: Story = {
  parameters: selectedAdapter("telegram"),
  args: {
    channels: [
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "telegram", status: "ready", address: "@example_bot" },
      { key: "phone", status: "not_configured" },
    ],
    channelPolicies: { telegram: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};

/**
 * Connected Phone: the connection header and trust-floor control, with no
 * Twilio credential fields.
 */
export const ChannelsTabPhoneConnected: Story = {
  parameters: selectedAdapter("phone"),
  args: {
    channels: [
      { key: "slack", status: "ready", address: "@example-assistant" },
      { key: "telegram", status: "not_configured" },
      { key: "phone", status: "ready", address: "+15550100" },
    ],
    channelPolicies: { phone: "trusted_contacts" },
    onChannelPolicyChange: () => {},
  },
};

/**
 * A `?setup=telegram` deep link (mobile chat handoff) selects Telegram and
 * lands on its manual credential form rather than the empty state.
 */
export const ChannelsTabTelegramSetupHandoff: Story = {
  parameters: {
    router: {
      initialEntries: ["/assistant/channels"],
      paths: CHANNELS_ROUTES,
    },
  },
  args: {
    initialChannel: "telegram",
  },
};
