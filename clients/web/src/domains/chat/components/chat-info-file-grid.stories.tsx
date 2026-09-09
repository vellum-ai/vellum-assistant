/**
 * The Chat Info panel's second level: one file category's whole set, wrapped
 * into a grid, with the paging control the daemon-backed categories offer.
 *
 * Every asset carries its own preview and the story client holds the bytes for
 * the one that does not, so the grid draws real pictures with no daemon behind
 * it. The tile's fetched and unavailable states are the file tile's own story.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_STORY_CLIENT,
  CHAT_INFO_STORY_FILES,
  chatInfoStoryFrames,
  inChatInfoDrawerColumn,
  inChatInfoPhonePage,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";

import { ChatInfoFileGrid } from "./chat-info-file-grid";

const meta: Meta<typeof ChatInfoFileGrid> = {
  title: "Chat/ChatInfoFileGrid",
  component: ChatInfoFileGrid,
  parameters: { layout: "fullscreen" },
  decorators: [withChatInfoStoryClient(CHAT_INFO_STORY_CLIENT)],
  args: {
    items: chatInfoStoryFrames(6),
    assistantId: CHAT_INFO_ASSISTANT_ID,
    hasMore: false,
    onLoadMore: fn(),
    onOpen: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ChatInfoFileGrid>;

/**
 * Camera Frames with more to come: each tile is labelled by capture time, and
 * the control under the grid fetches the next page.
 */
export const Frames: Story = {
  decorators: [inChatInfoDrawerColumn],
  args: { hasMore: true },
};

/**
 * Documents & Images, the whole category loaded: documents and attachments
 * side by side, and no paging control.
 */
export const Files: Story = {
  decorators: [inChatInfoDrawerColumn],
  args: { items: Object.values(CHAT_INFO_STORY_FILES) },
};

/** The same category on a phone, where the grid wraps into a narrower column. */
export const FilesOnAPhone: Story = {
  decorators: [inChatInfoPhonePage],
  globals: { viewport: { value: "sbCompactPhone", isRotated: false } },
  args: { items: Object.values(CHAT_INFO_STORY_FILES) },
};
