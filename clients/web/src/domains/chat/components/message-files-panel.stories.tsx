import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import {
  makeDisplayAttachment,
  makePreviewableImages,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { AttachmentOverflowSquare } from "@/domains/chat/components/chat-attachments/attachment-overflow-square";
import { MessageFilesPanel } from "./message-files-panel";

/**
 * The message-files side panel: every attachment on one transcript message,
 * each square opening the shared full-screen preview modal with gallery
 * navigation. Opened by the overflow tile at the end of a truncated assistant
 * attachment strip.
 */

const MIXED: DisplayAttachment[] = [
  makeDisplayAttachment({
    id: "img-0",
    filename: "quarterly-revenue.png",
    sizeBytes: 184_320,
    previewUrl: SAMPLE_PREVIEWS[0]!,
  }),
  makeDisplayAttachment({
    id: "deck-1",
    filename: "board-deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 4_194_304,
  }),
  makeDisplayAttachment({
    id: "report-1",
    filename: "annual-report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_097_152,
  }),
  makeDisplayAttachment({
    id: "img-1",
    filename: "hazard-gallery.png",
    sizeBytes: 188_416,
    previewUrl: SAMPLE_PREVIEWS[1]!,
  }),
  makeDisplayAttachment({
    id: "sheet-1",
    filename: "forecast.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 65_536,
  }),
  makeDisplayAttachment({
    id: "bundle-1",
    filename: "source-bundle.zip",
    mimeType: "application/zip",
    sizeBytes: 8_388_608,
  }),
  makeDisplayAttachment({
    id: "clip-1",
    filename: "walkthrough.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12_582_912,
    thumbnailUrl: SAMPLE_PREVIEWS[2]!,
  }),
  makeDisplayAttachment({
    id: "script-1",
    filename: "migrate.ts",
    mimeType: "text/plain",
    sizeBytes: 9_216,
  }),
];

const meta: Meta<typeof MessageFilesPanel> = {
  title: "Chat/MessageFilesPanel",
  component: MessageFilesPanel,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[400px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof MessageFilesPanel>;

/**
 * A mixed media / non-media set: an image renders its preview edge to edge,
 * everything else falls back to its file-kind icon on a neutral tile.
 */
export const MixedMedia: Story = {
  args: {
    payload: { messageId: "story-msg", attachments: MIXED },
    onClose: () => {},
  },
};

/**
 * A message whose attachments have all gone away - the panel shows its empty
 * state rather than a blank grid under a `Files · 0` header.
 */
export const Empty: Story = {
  args: {
    payload: { messageId: "story-empty", attachments: [] },
    onClose: () => {},
  },
};

/**
 * The overflow tile itself, in both states. The resting tile must read as a
 * dashed outline against the chat surface, and the active tile - the one whose
 * panel is open - must be clearly distinct from a plain hover. Hover the first
 * tile to compare.
 */
export const OverflowTileStates: StoryObj = {
  render: () => (
    <div className="flex items-start gap-6 bg-[var(--surface-base)] p-6">
      <div className="flex flex-col items-center gap-2">
        <AttachmentOverflowSquare
          count={3}
          payload={{ messageId: "story-resting", attachments: MIXED }}
        />
        <span className="text-xs text-[var(--content-tertiary)]">
          resting / hover
        </span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <AttachmentOverflowSquare
          count={12}
          payload={{ messageId: "story-active", attachments: MIXED }}
        />
        <span className="text-xs text-[var(--content-tertiary)]">
          click to activate
        </span>
      </div>
    </div>
  ),
};

/**
 * A photo-heavy message: the grid wraps to the panel's width rather than a
 * fixed column count, so it fills a widened drawer and the full-width mobile
 * overlay alike.
 */
export const Photos: Story = {
  args: {
    payload: {
      messageId: "story-photos",
      attachments: makePreviewableImages(12),
    },
    onClose: () => {},
  },
};
