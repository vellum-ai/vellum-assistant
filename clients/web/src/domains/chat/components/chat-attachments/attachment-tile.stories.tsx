/**
 * The mobile composer's attached image: a 100px square tile with a 24px
 * circular remove control and no caption. The filename appears only in the
 * tooltip and the accessible names, so these stories are about geometry: the
 * tile's crop, where the control sits on it, and how a row of tiles fits the
 * composer card at phone width.
 *
 * Switch the toolbar to the Mobile viewport for the widths these are drawn
 * against, and check both themes: the control is filled with the card's own
 * surface so it reads as a cut-out of the photo.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { SAMPLE_PREVIEWS } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { AttachmentTile } from "@/domains/chat/components/chat-attachments/attachment-tile";

/** Four attached photos, enough to overflow the card's tile row. */
const PHOTOS = [
  { id: "att-1", filename: "harbour.jpg", previewUrl: SAMPLE_PREVIEWS[0]! },
  {
    id: "att-2",
    filename: "dock-at-dusk.jpg",
    previewUrl: SAMPLE_PREVIEWS[3]!,
  },
  { id: "att-3", filename: "ferry.jpg", previewUrl: SAMPLE_PREVIEWS[5]! },
  { id: "att-4", filename: "gulls.jpg", previewUrl: SAMPLE_PREVIEWS[6]! },
];

const meta: Meta<typeof AttachmentTile> = {
  title: "Chat/AttachmentTile",
  component: AttachmentTile,
  parameters: { layout: "centered" },
  args: { ...PHOTOS[0]!, onRemove: fn(), onPreview: fn() },
};
export default meta;

type Story = StoryObj<typeof AttachmentTile>;

/** An uploaded image, cover-cropped to the square. */
export const Image: Story = {};

/**
 * The upload still in flight. The spinner face keeps the tile's geometry, so
 * the strip does not jump when the image lands.
 */
export const Uploading: Story = {
  args: { uploading: true, previewUrl: null },
};

/**
 * Two tiles inside the composer card at iPhone width: 12px in from the card's
 * top and left, 6px from its right and bottom, and 12px between the tile row
 * and the input row, which the empty row below stands in for.
 */
export const InCard: Story = {
  render: (args) => (
    <div className="flex w-[378px] flex-col gap-3 rounded-[26px] bg-[var(--surface-lift)] pb-1.5 pl-3 pr-1.5 pt-3">
      <div className="flex gap-2">
        {PHOTOS.slice(0, 2).map((photo) => (
          <AttachmentTile key={photo.id} {...args} {...photo} />
        ))}
      </div>
      <div className="h-[52px]" />
    </div>
  ),
};

/** Four tiles in the card's tile row, one past the three the width fits. */
export const Multiple: Story = {
  render: (args) => (
    <div className="flex w-[354px] gap-2 overflow-x-auto">
      {PHOTOS.map((photo) => (
        <AttachmentTile key={photo.id} {...args} {...photo} />
      ))}
    </div>
  ),
};
