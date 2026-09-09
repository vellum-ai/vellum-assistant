/**
 * The Chat Info panel's second level: one category's whole set, wrapped into a
 * grid, with the paging control the daemon-backed categories offer.
 *
 * Every asset carries its own preview, so the grid draws real pictures with no
 * daemon behind it. The tile's fetched and unavailable states are the file
 * tile's own story.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  makeDisplayAttachment,
  makeSamplePreview,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { CHAT_INFO_ASSISTANT_ID } from "@/domains/chat/components/chat-info-story-fixtures";
import {
  CHAT_INFO_T0,
  makeChatInfoQueryClient,
  makeDocumentAsset,
  makeDocumentSummary,
  makeFileAsset,
  makeFrameAsset,
} from "@/domains/chat/components/chat-info.test-helper";

import { ChatInfoCategoryGrid } from "./chat-info-category-grid";

/** One Live session: six captures a few minutes apart, newest first. */
const FRAMES = Array.from({ length: 6 }, (_, index) =>
  makeFrameAsset(
    makeDisplayAttachment({
      id: `camera-frame-${index + 1}`,
      filename: `camera-frame-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 98_304 + index * 2_048,
      previewUrl: SAMPLE_PREVIEWS[index % SAMPLE_PREVIEWS.length]!,
    }),
    CHAT_INFO_T0 - index * 180_000,
  ),
);

const FILES = [
  makeDocumentAsset(
    makeDocumentSummary({
      surfaceId: "surface-trip-notes",
      title: "Trip Notes",
      wordCount: 842,
    }),
  ),
  makeDocumentAsset(
    makeDocumentSummary({
      surfaceId: "surface-packing-list",
      title: "Packing List",
      wordCount: 214,
    }),
  ),
  makeFileAsset(
    makeDisplayAttachment({
      id: "harbour-at-dawn",
      filename: "harbour-at-dawn.png",
      sizeBytes: 184_320,
      previewUrl: makeSamplePreview(240, 150),
    }),
  ),
  makeFileAsset(
    makeDisplayAttachment({
      id: "ferry-deck",
      filename: "ferry-deck.png",
      sizeBytes: 190_464,
      previewUrl: SAMPLE_PREVIEWS[2]!,
    }),
  ),
  makeFileAsset(
    makeDisplayAttachment({
      id: "coast-guide",
      filename: "coast-guide.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2_097_152,
    }),
  ),
];

const storyClient = makeChatInfoQueryClient();

const inPanelBody: Decorator = (Story) => (
  <QueryClientProvider client={storyClient}>
    <div className="max-w-[560px] p-5">
      <Story />
    </div>
  </QueryClientProvider>
);

const meta: Meta<typeof ChatInfoCategoryGrid> = {
  title: "Chat/ChatInfoCategoryGrid",
  component: ChatInfoCategoryGrid,
  parameters: { layout: "fullscreen" },
  decorators: [inPanelBody],
  args: {
    items: FRAMES,
    assistantId: CHAT_INFO_ASSISTANT_ID,
    hasMore: false,
    onLoadMore: fn(),
    onOpen: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ChatInfoCategoryGrid>;

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
  args: { items: FILES },
};
