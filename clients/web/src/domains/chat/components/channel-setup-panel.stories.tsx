import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { ChannelSetupPanel } from "./channel-setup-panel";

const ASSISTANT_ID = "asst_story";

function seededClient(channel: ChannelSetupPayload["channel"], ready: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    channelsReadinessGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { success: true, snapshots: [{ channel, ready }] },
  );
  return client;
}

function withClient(client: QueryClient) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <DetailPanelStoryFrame>
          <Story />
        </DetailPanelStoryFrame>
      </QueryClientProvider>
    );
  };
}

const meta: Meta<typeof ChannelSetupPanel> = {
  title: "Chat/ChannelSetupPanel",
  component: ChannelSetupPanel,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ChannelSetupPanel>;

const slackPayload: ChannelSetupPayload = {
  channel: "slack",
  assistantId: ASSISTANT_ID,
  assistantName: "Vellum",
};

export const SlackSetup: Story = {
  args: { payload: slackPayload },
  decorators: [withClient(seededClient("slack", false))],
};

export const SlackConnected: Story = {
  args: { payload: slackPayload },
  decorators: [withClient(seededClient("slack", true))],
};

export const TelegramSetup: Story = {
  args: {
    payload: {
      channel: "telegram",
      assistantId: ASSISTANT_ID,
      assistantName: "Vellum",
    },
  },
  decorators: [withClient(seededClient("telegram", false))],
};

export const PhoneSetup: Story = {
  args: {
    payload: {
      channel: "phone",
      assistantId: ASSISTANT_ID,
      assistantName: "Vellum",
    },
  },
  decorators: [withClient(seededClient("phone", false))],
};
