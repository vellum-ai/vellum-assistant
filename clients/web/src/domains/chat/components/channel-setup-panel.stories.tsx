import type { Meta, StoryObj } from "@storybook/react-vite";

import { avatarRasterQueryKey } from "@/components/channel-avatar-download";
import { STORY_AVATAR_DATA_URI } from "@/components/channel-avatar-story-decorator";
import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { type SeedQueryCache, withQueryCache } from "@/lib/story-query-cache";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { ChannelSetupPanel } from "./channel-setup-panel";

const ASSISTANT_ID = "asst_story";

function seedReadiness(
  channel: ChannelSetupPayload["channel"],
  ready: boolean,
): SeedQueryCache {
  return (client) => {
    client.setQueryData(
      channelsReadinessGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      { success: true, snapshots: [{ channel, ready }] },
    );
  };
}

function withFrame(Story: () => React.ReactElement) {
  return (
    <DetailPanelStoryFrame>
      <Story />
    </DetailPanelStoryFrame>
  );
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
  decorators: [withFrame, withQueryCache(seedReadiness("slack", false))],
};

export const SlackConnected: Story = {
  args: { payload: slackPayload },
  decorators: [withFrame, withQueryCache(seedReadiness("slack", true))],
};

export const TelegramSetup: Story = {
  args: {
    payload: {
      channel: "telegram",
      assistantId: ASSISTANT_ID,
      assistantName: "Vellum",
    },
  },
  decorators: [withFrame, withQueryCache(seedReadiness("telegram", false))],
};

export const DiscordSetup: Story = {
  args: {
    payload: {
      channel: "discord",
      assistantId: ASSISTANT_ID,
      assistantName: "Vellum",
    },
  },
  decorators: [
    withFrame,
    withQueryCache((client) => {
      seedReadiness("discord", false)(client);
      client.setQueryData(
        avatarRasterQueryKey(ASSISTANT_ID),
        STORY_AVATAR_DATA_URI,
      );
    }),
  ],
};

export const PhoneSetup: Story = {
  args: {
    payload: {
      channel: "phone",
      assistantId: ASSISTANT_ID,
      assistantName: "Vellum",
    },
  },
  decorators: [withFrame, withQueryCache(seedReadiness("phone", false))],
};
