import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentOverflowSquare } from "@/domains/chat/components/chat-attachments/attachment-overflow-square";
import { MessageFilesPanel } from "./message-files-panel";

/**
 * The message-files side panel: every attachment on one transcript message,
 * each square opening the shared full-screen preview modal with gallery
 * navigation. Opened by the overflow tile at the end of a truncated assistant
 * attachment strip.
 */

function makeAttachment(
  overrides: Partial<DisplayAttachment> & { id: string },
): DisplayAttachment {
  return {
    filename: `${overrides.id}.png`,
    mimeType: "image/png",
    sizeBytes: 1_024,
    previewUrl: null,
    ...overrides,
  };
}

const MIXED: DisplayAttachment[] = [
  makeAttachment({
    id: "img-0",
    filename: "quarterly-revenue.png",
    sizeBytes: 184_320,
  }),
  makeAttachment({
    id: "deck-1",
    filename: "board-deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 4_194_304,
  }),
  makeAttachment({
    id: "report-1",
    filename: "annual-report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_097_152,
  }),
  makeAttachment({
    id: "sheet-1",
    filename: "forecast.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 65_536,
  }),
  makeAttachment({
    id: "bundle-1",
    filename: "source-bundle.zip",
    mimeType: "application/zip",
    sizeBytes: 8_388_608,
  }),
  makeAttachment({
    id: "clip-1",
    filename: "walkthrough.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12_582_912,
  }),
  makeAttachment({
    id: "notes-1",
    filename: "meeting-notes.md",
    mimeType: "text/markdown",
    sizeBytes: 3_072,
  }),
  makeAttachment({
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
