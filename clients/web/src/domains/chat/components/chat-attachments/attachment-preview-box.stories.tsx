/**
 * The box an attachment draws itself in, in each of the four branches it picks
 * between: the kind's glyph, a decodable image, a video poster, and the
 * placeholder an owner shows while the bytes are still on their way.
 *
 * Geometry, surface, and border belong to the caller, so every story wears the
 * Chat Info file tile's box and they differ only in what the box has to draw.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { Loader2 } from "lucide-react";
import { fn } from "storybook/test";

import {
  makeSamplePreview,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { AttachmentPreviewBox } from "@/domains/chat/components/chat-attachments/attachment-preview-box";
import { CHAT_INFO_FILE_TILE_WIDTH_PX } from "@/domains/chat/components/chat-info-file-tile";

/** The Chat Info file tile's box, at its 84px height on the panel's surface. */
const TILE_CLASS = "h-[84px] w-full rounded-lg bg-[var(--surface-base)]";

/** The tile's width, which the box fills; only the tile's height is a literal. */
const atTileWidth: Decorator = (Story) => (
  <div style={{ width: CHAT_INFO_FILE_TILE_WIDTH_PX }}>
    <Story />
  </div>
);

const meta: Meta<typeof AttachmentPreviewBox> = {
  title: "Chat/AttachmentPreviewBox",
  component: AttachmentPreviewBox,
  parameters: { layout: "centered" },
  decorators: [atTileWidth],
  args: {
    className: TILE_CLASS,
    kind: "image",
    imageUrl: null,
    posterUrl: null,
    glyphClassName: "size-8",
    onImageError: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof AttachmentPreviewBox>;

/**
 * Nothing to draw, so the box falls back to the kind's glyph. This is where a
 * non-media file settles and stays.
 */
export const Glyph: Story = {
  args: { kind: "pdf" },
};

/**
 * A decodable image, cover-cropped to the box: the 240x150 source keeps its
 * middle band and loses a slice off the top and the bottom.
 */
export const Image: Story = {
  args: { imageUrl: makeSamplePreview(240, 150) },
};

/**
 * A video poster, painted behind the box rather than as an image element.
 * A poster that fails to load has nothing to swap to, so it never gets to
 * raise the broken-image glyph.
 */
export const VideoPoster: Story = {
  args: { kind: "video", posterUrl: SAMPLE_PREVIEWS[2]! },
};

/**
 * The bytes are still on their way. The owner's placeholder stands in for the
 * glyph, so the box does not first settle on a fallback it is about to replace.
 */
export const Placeholder: Story = {
  args: {
    placeholder: (
      <Loader2 className="size-8 animate-spin text-[var(--content-tertiary)]" />
    ),
  },
};
