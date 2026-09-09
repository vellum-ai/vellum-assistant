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

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import {
  CHAT_INFO_ASSISTANT_ID,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import {
  CHAT_INFO_DRAWER_WIDTH_PX,
  CHAT_INFO_NARROW_PHONE_PX,
  CHAT_INFO_STORY_FILES,
  chatInfoStoryFrames,
} from "@/domains/chat/components/chat-info.test-helper";

import { ChatInfoFileGrid } from "./chat-info-file-grid";

/** The drawer body's column on the desktop mock, inside `DetailShell`'s body inset. */
const inDrawerColumn: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{ padding: DETAIL_SHELL_BODY_INSET_PX }}
  >
    <div style={{ width: CHAT_INFO_DRAWER_WIDTH_PX }}>
      <Story />
    </div>
  </div>
);

/** The same page on the narrowest phone the app runs on. */
const inPhonePage: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{
      maxWidth: CHAT_INFO_NARROW_PHONE_PX,
      padding: DETAIL_SHELL_BODY_INSET_PX,
    }}
  >
    <Story />
  </div>
);

const meta: Meta<typeof ChatInfoFileGrid> = {
  title: "Chat/ChatInfoFileGrid",
  component: ChatInfoFileGrid,
  parameters: { layout: "fullscreen" },
  decorators: [withChatInfoStoryClient],
  args: {
    items: chatInfoStoryFrames(6),
    assistantId: CHAT_INFO_ASSISTANT_ID,
    status: "ready",
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
  decorators: [inDrawerColumn],
  args: { hasMore: true },
};

/**
 * Documents & Images, the whole category loaded: documents and attachments
 * side by side, and no paging control.
 */
export const Files: Story = {
  decorators: [inDrawerColumn],
  args: { items: Object.values(CHAT_INFO_STORY_FILES) },
};

/** The same category on a phone, where the grid wraps into a narrower column. */
export const FilesOnAPhone: Story = {
  decorators: [inPhonePage],
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
  args: { items: Object.values(CHAT_INFO_STORY_FILES) },
};

/** A category drilled into with nothing in it says so where the tiles were. */
export const Empty: Story = {
  decorators: [inDrawerColumn],
  args: { items: [] },
};
