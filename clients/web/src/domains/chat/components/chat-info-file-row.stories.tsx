/**
 * The Chat Info panel's file row, on the category the panel's own suite cannot
 * reach: Camera Frames. Documents and images render through this same row, so
 * what these stories document is the category's own copy over its file tiles,
 * and the fit rule the row inherits from `ChatInfoSection`.
 *
 * The title and the See All label come from the catalog through `t()`, the way
 * the panel supplies them, so the row is read on the copy that ships.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_STORY_CLIENT,
  chatInfoStoryFrames,
  inChatInfoDrawerColumn,
  inChatInfoPhonePage,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import { useTranslation } from "@/i18n";

import { ChatInfoFileRow } from "./chat-info-file-row";

/** Everything but the copy, which the catalog supplies through the hook below. */
type FramesRowArgs = Omit<
  ComponentProps<typeof ChatInfoFileRow>,
  "title" | "seeAllAriaLabel"
>;

/** The real row, on the two catalog keys the panel hands the frames category. */
function FramesRow(args: FramesRowArgs) {
  const { t } = useTranslation("chat");
  return (
    <ChatInfoFileRow
      {...args}
      title={t("chatInfoPanel.framesTitle")}
      seeAllAriaLabel={t("chatInfoPanel.seeAllFramesAria")}
    />
  );
}

const meta = {
  title: "Chat/ChatInfoFileRow",
  component: FramesRow,
  parameters: { layout: "fullscreen" },
  decorators: [withChatInfoStoryClient(CHAT_INFO_STORY_CLIENT)],
  args: {
    category: "frames",
    count: 240,
    items: chatInfoStoryFrames(6),
    assistantId: CHAT_INFO_ASSISTANT_ID,
    onSeeAll: fn(),
    onOpen: fn(),
  },
} satisfies Meta<typeof FramesRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Camera Frames at the drawer width: each tile carries the time its frame was
 * captured, the line is cut to what the column holds, and the session's total
 * puts See All in the header.
 */
export const Frames: Story = {
  decorators: [inChatInfoDrawerColumn],
};

/** The same row on a phone, where the whole session scrolls past the screen edge. */
export const FramesStrip: Story = {
  decorators: [inChatInfoPhonePage],
  globals: { viewport: { value: "sbCompactPhone", isRotated: false } },
};
