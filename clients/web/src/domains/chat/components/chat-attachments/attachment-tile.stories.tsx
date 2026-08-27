/**
 * The mobile composer's attached image: a 100px square tile with a 24px
 * circular remove control and no caption. The filename appears only in the
 * tooltip and the accessible names, so these stories are about geometry: the
 * tile's crop, where the control sits on it, and how a row of tiles fits the
 * composer card at phone width.
 *
 * The phone-width stories run fullscreen and draw the phone's own 12px page
 * margin, so read them at the Mobile viewport. Check both themes: the control
 * is filled with the card's own surface so it reads as a cut-out of the photo.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { fn } from "storybook/test";

import { SAMPLE_PREVIEWS } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { AttachmentTile } from "@/domains/chat/components/chat-attachments/attachment-tile";

/**
 * A non-square preview: three bands along the long edge with a dot centred on
 * the middle one. Dropped into the square tile, `object-cover` eats most of
 * the outer two bands, which is the crop these stories are here to show.
 */
function bandedPreview(width: number, height: number, hue: number): string {
  const landscape = width > height;
  const band = (landscape ? width : height) / 3;
  const bands = [0, 1, 2]
    .map((index) => {
      const fill = `hsl(${hue + index * 18} 58% ${34 + index * 16}%)`;
      const offset = index * band;
      return landscape
        ? `<rect x="${offset}" y="0" width="${band}" height="${height}" fill="${fill}"/>`
        : `<rect x="0" y="${offset}" width="${width}" height="${band}" fill="${fill}"/>`;
    })
    .join("");
  const dot = `<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 5}" fill="#ffffff" fill-opacity="0.85"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bands}${dot}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 160x96, so the square crop drops a slice off each end. */
const LANDSCAPE_PREVIEW = bandedPreview(160, 96, 196);
/** 96x160, so the square crop drops a slice off the top and the bottom. */
const PORTRAIT_PREVIEW = bandedPreview(96, 160, 24);

/**
 * Four attached photos, enough to overflow the card's tile row. The first two
 * are non-square, so the tiles they land in have to crop.
 */
const PHOTOS = [
  { id: "att-1", filename: "harbour.jpg", previewUrl: LANDSCAPE_PREVIEW },
  {
    id: "att-2",
    filename: "dock-at-dusk.jpg",
    previewUrl: PORTRAIT_PREVIEW,
  },
  { id: "att-3", filename: "ferry.jpg", previewUrl: SAMPLE_PREVIEWS[5]! },
  { id: "att-4", filename: "gulls.jpg", previewUrl: SAMPLE_PREVIEWS[6]! },
];

/**
 * The phone's page margin, which the fullscreen canvas does not supply. The
 * card fills what is left, 366px on the 390px Mobile viewport and 378px on a
 * 402px device, the same rule the real composer follows.
 */
function PhonePage({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[402px] bg-[var(--surface-base)] p-3">{children}</div>
  );
}

const meta: Meta<typeof AttachmentTile> = {
  title: "Chat/AttachmentTile",
  component: AttachmentTile,
  parameters: { layout: "centered" },
  args: { ...PHOTOS[0]!, onRemove: fn(), onPreview: fn() },
};
export default meta;

type Story = StoryObj<typeof AttachmentTile>;

/**
 * An uploaded image. The 160x96 source is cover-cropped to the square, so the
 * tile keeps the middle band and loses most of the two either side of it.
 */
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
 * and the input row, which the empty row below stands in for. The landscape
 * and portrait sources crop to the same square.
 */
export const InCard: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <PhonePage>
      <div className="flex w-full flex-col gap-3 rounded-[26px] bg-[var(--surface-lift)] pb-1.5 pl-3 pr-1.5 pt-3">
        <div className="flex gap-2">
          {PHOTOS.slice(0, 2).map((photo) => (
            <AttachmentTile key={photo.id} {...args} {...photo} />
          ))}
        </div>
        <div className="h-[52px]" />
      </div>
    </PhonePage>
  ),
};

/** Four tiles in the card's tile row, one past the three the width fits. */
export const Multiple: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <PhonePage>
      <div className="flex w-full gap-2 overflow-x-auto">
        {PHOTOS.map((photo) => (
          <AttachmentTile key={photo.id} {...args} {...photo} />
        ))}
      </div>
    </PhonePage>
  ),
};
