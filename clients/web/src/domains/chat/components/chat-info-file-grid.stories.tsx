/**
 * The Chat Info panel's second level: one file category's whole set, wrapped
 * into a grid, with the paging control the daemon-backed categories offer.
 *
 * Every asset carries its own preview and the story client holds the bytes for
 * the one that does not, so the grid draws real pictures with no daemon behind
 * it. The tile's fetched and unavailable states are the file tile's own story.
 */

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import {
  CHAT_INFO_STORY_FILES,
  chatInfoStoryFrames,
} from "@/domains/chat/components/chat-info.test-helper";

import { ChatInfoFileGrid } from "./chat-info-file-grid";

const inPanelBody: Decorator = (Story) => (
  <div className="max-w-[560px] p-5">
    <Story />
  </div>
);

const meta: Meta<typeof ChatInfoFileGrid> = {
  title: "Chat/ChatInfoFileGrid",
  component: ChatInfoFileGrid,
  parameters: { layout: "fullscreen" },
  decorators: [inPanelBody, withChatInfoStoryClient],
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
  args: { hasMore: true },
};

/**
 * Documents & Images, the whole category loaded: documents and attachments
 * side by side, and no paging control.
 */
export const Files: Story = {
  args: { items: Object.values(CHAT_INFO_STORY_FILES) },
};

/** A category drilled into with nothing in it says so where the tiles were. */
export const Empty: Story = {
  args: { items: [] },
};
