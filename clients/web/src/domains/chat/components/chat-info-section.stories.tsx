/**
 * A Chat Info row: the category header with its exact total and a See All
 * control, over one line of tiles.
 *
 * The row is tile-agnostic, so these stories feed it the shipped 64px
 * `MessageAttachmentSquare`. What they document is the fit rule: on a roomy
 * window the line is truncated to the tiles its measured width holds, and on a
 * phone the same width decides a horizontal strip that runs past the screen
 * edge. See All appears whenever the category's total exceeds that line, which
 * is why the paged story shows it under a row that looks complete. The panel's
 * own rows over its own tiles are `ChatInfoFileRow`'s stories.
 *
 * Read the phone stories at the Mobile viewports: the frame draws
 * `DetailShell`'s lift surface and body inset, which the strip cancels.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  makeMixedAttachments,
  makePreviewableImages,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import {
  inChatInfoDrawerColumn,
  inChatInfoPhonePage,
} from "@/domains/chat/components/chat-info-story-fixtures";
import type { DisplayAttachment } from "@/domains/chat/types/types";

import {
  ChatInfoSection,
  type ChatInfoSectionProps,
} from "./chat-info-section";

/** `MessageAttachmentSquare`'s tile box, the width the fit rule is given. */
const SQUARE_TILE_WIDTH_PX = 64;

/**
 * A category small enough for one line: two photos carrying a real preview,
 * then a deck, a report, and an archive on their kind glyphs.
 */
const FITTING_SET: DisplayAttachment[] = [
  ...makePreviewableImages(2),
  ...makeMixedAttachments().filter((file) => file.previewUrl === null),
];

function renderSquare(attachment: DisplayAttachment) {
  return (
    <MessageAttachmentSquare key={attachment.id} attachment={attachment} />
  );
}

const meta = {
  title: "Chat/ChatInfoSection",
  component: ChatInfoSection,
  parameters: { layout: "fullscreen" },
  argTypes: { renderTile: { control: false } },
  args: {
    title: "Documents & Images",
    tileWidth: SQUARE_TILE_WIDTH_PX,
    seeAllAriaLabel: "See all documents and images",
    renderTile: renderSquare,
    onSeeAll: fn(),
  },
} satisfies Meta<ChatInfoSectionProps<DisplayAttachment>>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A category that fits on one line: every tile renders and the header carries
 * no See All, because the count and the fitted line agree.
 */
export const Fit: Story = {
  decorators: [inChatInfoDrawerColumn],
  args: {
    items: FITTING_SET,
    count: FITTING_SET.length,
  },
};

/**
 * More tiles than the row holds. The line is cut to what fits and See All
 * takes the right edge of the header.
 */
export const Overflow: Story = {
  decorators: [inChatInfoDrawerColumn],
  args: {
    items: makePreviewableImages(12),
    count: 12,
  },
};

/**
 * A paged category whose first page fits. The row looks complete, but the
 * total is the number See All is decided from, so the drill-in is still
 * offered.
 */
export const PagedCount: Story = {
  decorators: [inChatInfoDrawerColumn],
  args: {
    items: makePreviewableImages(4),
    count: 240,
  },
};

/**
 * The phone treatment: the whole fetched set on one horizontally scrolling
 * strip, bleeding past the body inset so the last visible tile is cut off at
 * the screen edge.
 */
export const MobileStrip: Story = {
  decorators: [inChatInfoPhonePage],
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  args: {
    items: makePreviewableImages(8),
    count: 12,
  },
};

/** The same strip at the width the phone page is drawn for, where its own cap binds. */
export const NarrowPhoneStrip: Story = {
  decorators: [inChatInfoPhonePage],
  globals: { viewport: { value: "sbCompactPhone", isRotated: false } },
  args: {
    items: makePreviewableImages(8),
    count: 12,
  },
};
