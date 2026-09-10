/**
 * The Chat Info panel's file tile, in each of the states it settles into: a
 * document, an image it already holds, an image it has to fetch, an image it
 * cannot get, a non-image glyph, a video poster, and a camera frame labelled
 * with when it was captured.
 *
 * `LazyImage` draws the bytes the shared story client holds, under the same
 * `attachmentContentQueryKey` the preview modal fetches with, so the story
 * shows the fetched path without a daemon behind it.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  makeDisplayAttachment,
  makeSamplePreview,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_STORY_CLIENT,
  CHAT_INFO_STORY_FILES,
  chatInfoStoryFrames,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import { makeFileAsset } from "@/domains/chat/components/chat-info.test-helper";

import { ChatInfoFileTile } from "./chat-info-file-tile";

const { tripNotes, inlineImage, lazyImage, pdf } = CHAT_INFO_STORY_FILES;

/** A legacy row: a synthetic id the content endpoint can never resolve. */
const LAZY_IMAGE_UNAVAILABLE = makeFileAsset(
  makeDisplayAttachment({
    id: "rehydrated:0",
    filename: "gulls-at-dusk.png",
    sizeBytes: 176_128,
  }),
);

const VIDEO_FILE = makeFileAsset(
  makeDisplayAttachment({
    id: "harbour-tour",
    filename: "harbour-tour.mp4",
    mimeType: "video/mp4",
    sizeBytes: 8_388_608,
    thumbnailUrl: makeSamplePreview(240, 150),
  }),
);

const FRAME_FILE = chatInfoStoryFrames(1)[0]!;

const meta: Meta<typeof ChatInfoFileTile> = {
  title: "Chat/ChatInfoFileTile",
  component: ChatInfoFileTile,
  parameters: { layout: "centered" },
  decorators: [withChatInfoStoryClient(CHAT_INFO_STORY_CLIENT)],
  args: {
    file: tripNotes,
    assistantId: CHAT_INFO_ASSISTANT_ID,
    onOpen: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatInfoFileTile>;

/** A daemon document: the text glyph, and the only tile kind with a menu. */
export const Document: Story = {};

/** An image the transcript already carries, drawn straight from its data URL. */
export const InlineImage: Story = {
  args: { file: inlineImage },
};

/** An image whose bytes the tile fetches once it is on screen. */
export const LazyImage: Story = {
  args: { file: lazyImage },
};

/** A legacy image with no bytes to fetch: the tile settles straight on the glyph. */
export const LazyImageUnavailable: Story = {
  args: { file: LAZY_IMAGE_UNAVAILABLE },
};

/** A non-image attachment, which is always its kind's glyph. */
export const Pdf: Story = {
  args: { file: pdf },
};

/** A video, painted from its poster frame rather than an image element. */
export const VideoPoster: Story = {
  args: { file: VIDEO_FILE },
};

/** A camera frame, labelled by capture time: the time of day for today's, the date for an older one. */
export const Frame: Story = {
  args: { file: FRAME_FILE },
};

/** Four tiles at the panel's 8px gutter, the way a row of them reads together. */
export const Row: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <div className="flex gap-2">
      <ChatInfoFileTile {...args} file={tripNotes} />
      <ChatInfoFileTile {...args} file={inlineImage} />
      <ChatInfoFileTile {...args} file={pdf} />
      <ChatInfoFileTile {...args} file={FRAME_FILE} />
    </div>
  ),
};
